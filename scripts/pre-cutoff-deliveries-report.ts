/**
 * Pre-cutoff supplier deliveries — files that reached a supplier's SharePoint
 * folder for POs BELOW the supplier-send cutoff, grouped PO by PO so a human
 * can approve or reject a whole order at once.
 *
 * THIS SCRIPT CANNOT DELETE ANYTHING. It has no --delete, no --execute, no
 * guarded destructive branch — every call in it is a findMany/findUnique/count
 * against Postgres, and it makes no Graph calls at all. Removing the files is a
 * deliberate manual job in SharePoint; this report is the checklist for it. A
 * delete flag on a report is how the wrong PO gets emptied at 23:00, so the
 * capability is simply absent rather than gated.
 *
 * WHICH CUTOFF, AND WHY
 * ---------------------
 * There are three: the SCRAPE cutoff (automationMinPo — which POs get their
 * barcodes resolved), the GENERATION cutoff (generationMinPo — which styles the
 * runner will render), and the SUPPLIER-SEND cutoff (supplierSendMinPo — which
 * orders may be put in front of a supplier). This report uses SUPPLIER-SEND,
 * read through getSupplierSendMinPo, because the question here is what was
 * DELIVERED, not what was generated: a below-cutoff PDF sitting in our own
 * database is not the problem, the same PDF sitting in the supplier's folder is.
 * Scope is decided by isDeliverablePo — the same predicate the four delivery
 * gates use — so the report and the gates can never disagree about what counts
 * as below the line. That includes its treatment of a NULL poSeq: unplaceable
 * on the timeline the cutoff draws, therefore not deliverable, therefore in
 * scope here.
 *
 * WHY THIS EXISTS
 * ---------------
 * The cover arm used to bypass the supplier-send cutoff entirely: a bulk
 * regeneration armed every regenerated style's cover into the send queue, and
 * the midnight batch delivered them regardless of PO. The code hole is closed —
 * the cutoff is now enforced at all four gates — but the artefacts that run
 * created are still in the suppliers' folders. Nothing removes them
 * automatically, and nothing should.
 *
 * WHERE THE EVIDENCE COMES FROM
 * -----------------------------
 * Two ledgers, deliberately both:
 *
 *   • SupplierSendQueueItem — CURRENT state. sharePointStatus UPLOADED plus
 *     sharePointUrl/sharePointFolderUrl is the app's belief about what is in
 *     the folder right now. This is the delete list.
 *   • Log ("pushed N output(s) to supplier folder …") — HISTORY. Every push
 *     goes through pushApprovedAssetsToSupplier, which writes one of these with
 *     a payload naming each file. It records WHEN each push happened, and it is
 *     the only trace of the MANUAL per-style push buttons, which never touched
 *     the cutoff and never stamp a queue row.
 *
 * A queue row is one output SLOT, not one file: a split-per-EAN slot writes
 * several PDFs under one row. By default the report names the stored
 * representative asset; --expand-docs re-expands each slot to every document
 * the push would write today (collectExpectedDocs, the same expansion the
 * delivery audit uses), at the cost of a per-style query.
 *
 * DELETION SAFETY, WHICH IS THE POINT OF THE GROUPING
 * ---------------------------------------------------
 * The PO folder is shared: "<PO> - <customer> - <supplier>" holds every style
 * on that PO, and its APPROVED LAYOUTS subfolder holds all their PDFs. So the
 * report checks each in-scope folder for queue rows that are ABOVE the cutoff
 * and flags it as MIXED — deleting that folder wholesale would take legitimate
 * deliveries with it. It also flags files sharing one sanitised name, because
 * in SharePoint those are ONE file: deleting "it" removes the survivor of an
 * overwrite, not a copy.
 *
 *   npx tsx --env-file=.env scripts/pre-cutoff-deliveries-report.ts
 *   npx tsx --env-file=.env scripts/pre-cutoff-deliveries-report.ts --expand-docs
 *   npx tsx --env-file=.env scripts/pre-cutoff-deliveries-report.ts --po=12345
 *   npx tsx --env-file=.env scripts/pre-cutoff-deliveries-report.ts --json
 */
import { db } from "@/lib/db";
import {
  getSupplierSendMinPo,
  getSupplierSendMinPoExplicit,
} from "@/lib/settings/app-settings";
import { isDeliverablePo, belowCutoffNote } from "@/lib/publish/supplier-send-cutoff";
import { sanitizeFileName } from "@/lib/sharepoint/supplier-folder";
import { supplierParentFolderName, APPROVED_LAYOUTS_SUBFOLDER } from "@/lib/sharepoint/supplier-folder-names";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const expandDocs = args.includes("--expand-docs");
const poArg = args.find((a) => a.startsWith("--po="))?.split("=")[1]?.trim() || null;

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const fmt = (d: Date | null | undefined) => (d ? DATE.format(d) : "—");

type FileRow = {
  fileName: string; // as stored on the asset
  spName: string; // sanitised — the name SharePoint actually keys on
  variantKey: string;
  docType: string;
  displayName: string | null;
  jobAssetId: string | null;
  jobId: string | null;
  jobCreatedAt: Date | null;
  assetCreatedAt: Date | null;
  styleId: string;
  styleName: string;
  sharePointUrl: string | null;
  pushedAt: Date | null; // most recent push attempt on the queue row
  firstPushAt: Date | null; // earliest push event in the log
  lastPushAt: Date | null; // latest push event in the log
  pushEvents: number;
  emailedAt: Date | null;
  sharePointStatus: string;
};

type FolderRow = {
  folderName: string;
  folderUrl: string | null;
  supplierName: string;
  customerName: string;
  files: FileRow[];
  // Queue rows ABOVE the cutoff pointing at this same folder — legitimate
  // deliveries that a wholesale folder delete would destroy.
  aboveCutoffRows: number;
  // Sanitised names carried by more than one in-scope file: in SharePoint
  // these are a single file that survived an overwrite.
  collidingNames: string[];
};

type PoGroup = {
  poNumber: string;
  poSeq: number | null;
  reason: string;
  styles: number;
  folders: FolderRow[];
};

async function main() {
  const cutoff = await getSupplierSendMinPo();
  const explicit = await getSupplierSendMinPoExplicit();

  if (cutoff === null) {
    console.log(
      "No supplier-send cutoff is configured (supplierSendMinPo unset, and the generation and scrape\n" +
        "cutoffs it falls back to are unset too). With no cutoff, nothing is below it — every delivery\n" +
        "is in policy and there is nothing for this report to find. Set a cutoff on /settings/approved\n" +
        "first if you expected results.",
    );
    await db.$disconnect();
    return;
  }

  // Everything the app believes is in a supplier folder. Fetched whole (a few
  // thousand rows) rather than filtered in SQL, so the above-cutoff rows are in
  // hand for the MIXED-folder check below — that check is the difference
  // between a safe manual delete and a destructive one.
  const allRows = await db.supplierSendQueueItem.findMany({
    select: {
      styleId: true,
      variantKey: true,
      jobAssetId: true,
      docType: true,
      displayName: true,
      poSeq: true,
      sharePointStatus: true,
      sharePointUrl: true,
      sharePointFolderUrl: true,
      lastPushAt: true,
      sentAt: true,
      queuedAt: true,
      updatedAt: true,
    },
  });

  // "Reached SharePoint" = the app has a URL for it, or says UPLOADED. Rows
  // still PENDING / NO_FOLDER / AMBIGUOUS never wrote anything, so they are not
  // artefacts to clean up (they're the gate working, late).
  const delivered = allRows.filter((r) => r.sharePointStatus === "UPLOADED" || r.sharePointUrl !== null);
  const inScope = delivered.filter((r) => !isDeliverablePo(r.poSeq, cutoff));
  const aboveCutoffByFolder = new Map<string, number>();
  for (const r of delivered) {
    if (!isDeliverablePo(r.poSeq, cutoff)) continue;
    const key = r.sharePointFolderUrl ?? "";
    if (!key) continue;
    aboveCutoffByFolder.set(key, (aboveCutoffByFolder.get(key) ?? 0) + 1);
  }

  if (inScope.length === 0) {
    console.log(
      `\nNothing found. No delivered supplier-send row is below the cutoff (PO >= ${cutoff}` +
        `${explicit === null ? ", inherited from the generation cutoff" : ""}).\n`,
    );
    await db.$disconnect();
    return;
  }

  const styles = await db.style.findMany({
    where: { id: { in: [...new Set(inScope.map((r) => r.styleId))] } },
    select: {
      id: true,
      name: true,
      poNumber: true,
      poSeq: true,
      customer: { select: { name: true } },
      supplier: { select: { name: true } },
    },
  });
  const styleById = new Map(styles.map((s) => [s.id, s]));

  // Narrow to one PO HERE rather than at print time, so --po also shrinks every
  // enrichment query below (and, with --expand-docs, the per-style expansion —
  // otherwise scoping to one order would still pay for all of them).
  const scoped = poArg
    ? inScope.filter((r) => (styleById.get(r.styleId)?.poNumber?.trim() || "(no PO number)") === poArg)
    : inScope;
  if (scoped.length === 0) {
    console.log(`\nNo below-cutoff delivered files for PO "${poArg}".\n`);
    await db.$disconnect();
    return;
  }
  const styleIds = [...new Set(scoped.map((r) => r.styleId))];

  // Asset + job detail for "which style and which job created it".
  const assetIds = scoped.map((r) => r.jobAssetId).filter((x): x is string => x !== null);
  const assets =
    assetIds.length === 0
      ? []
      : await db.jobAsset.findMany({
          where: { id: { in: assetIds } },
          select: {
            id: true,
            fileName: true,
            docType: true,
            displayName: true,
            createdAt: true,
            jobId: true,
            job: { select: { id: true, createdAt: true, styleId: true } },
          },
        });
  const assetById = new Map(assets.map((a) => [a.id, a]));

  // History: the push events themselves. Scoped to the in-scope styles' jobs so
  // this stays a bounded read rather than the whole log table.
  const jobs = await db.job.findMany({
    where: { styleId: { in: styleIds } },
    select: { id: true, styleId: true },
  });
  const jobIds = jobs.map((j) => j.id);
  const pushLogs =
    jobIds.length === 0
      ? []
      : await db.log.findMany({
          where: { jobId: { in: jobIds }, message: { startsWith: "pushed " } },
          select: { createdAt: true, payload: true },
          orderBy: { createdAt: "asc" },
        });
  // assetId → { first, last, count }. The payload's `pushed` array names every
  // file that PUT succeeded for, which is the only per-file push timestamp we
  // have; the queue row's lastPushAt is per slot and only ever the latest.
  const pushHistory = new Map<string, { first: Date; last: Date; count: number }>();
  for (const log of pushLogs) {
    const payload = log.payload as { pushed?: Array<{ assetId?: unknown }> } | null;
    if (!payload || !Array.isArray(payload.pushed)) continue;
    for (const p of payload.pushed) {
      if (typeof p?.assetId !== "string") continue;
      const entry = pushHistory.get(p.assetId);
      if (!entry) pushHistory.set(p.assetId, { first: log.createdAt, last: log.createdAt, count: 1 });
      else {
        entry.last = log.createdAt;
        entry.count += 1;
      }
    }
  }

  // Optional slot → documents expansion. Off by default: it costs one
  // current-outputs resolve per style, and the representative asset already
  // names the file for every single-document slot (the overwhelming majority).
  const expandedByStyle = new Map<
    string,
    Array<{ variantKey: string; baseKey: string; fileName: string; docType: string; name: string; jobAssetId: string }>
  >();
  if (expandDocs) {
    const { collectExpectedDocs } = await import("@/lib/sharepoint/style-delivery-audit");
    for (const styleId of styleIds) {
      try {
        const { expected } = await collectExpectedDocs(styleId);
        expandedByStyle.set(styleId, expected);
      } catch {
        // A style whose current outputs won't resolve falls back to the
        // representative below — reported, never silently dropped.
      }
    }
    const extraAssetIds = [...expandedByStyle.values()]
      .flat()
      .map((d) => d.jobAssetId)
      .filter((id) => !assetById.has(id));
    if (extraAssetIds.length > 0) {
      const extra = await db.jobAsset.findMany({
        where: { id: { in: [...new Set(extraAssetIds)] } },
        select: {
          id: true,
          fileName: true,
          docType: true,
          displayName: true,
          createdAt: true,
          jobId: true,
          job: { select: { id: true, createdAt: true, styleId: true } },
        },
      });
      for (const a of extra) assetById.set(a.id, a);
    }
  }

  // PO → folder → files. The PO is the approval unit: one order, one decision.
  const groups = new Map<string, PoGroup>();

  for (const row of scoped) {
    const style = styleById.get(row.styleId);
    if (!style) continue;
    const poNumber = style.poNumber?.trim() || "(no PO number)";

    const customerName = style.customer?.name ?? "(no customer)";
    const supplierName = style.supplier?.name ?? "(no supplier)";
    const folderName = supplierParentFolderName({
      poNumber: style.poNumber,
      styleName: style.name,
      customerName,
      supplierName,
    });
    const folderUrl = row.sharePointFolderUrl;

    const group =
      groups.get(poNumber) ??
      ({
        poNumber,
        poSeq: style.poSeq,
        reason: belowCutoffNote(row.poSeq ?? style.poSeq, cutoff),
        styles: 0,
        folders: [],
      } satisfies PoGroup);

    const folderKey = folderUrl ?? folderName;
    let folder = group.folders.find((f) => (f.folderUrl ?? f.folderName) === folderKey);
    if (!folder) {
      folder = {
        folderName,
        folderUrl,
        supplierName,
        customerName,
        files: [],
        aboveCutoffRows: folderUrl ? (aboveCutoffByFolder.get(folderUrl) ?? 0) : 0,
        collidingNames: [],
      };
      group.folders.push(folder);
    }

    // The documents this row put in the folder. --expand-docs asks what the
    // push writes for the whole slot; otherwise the stored representative.
    const expanded = expandDocs
      ? (expandedByStyle.get(row.styleId) ?? []).filter((d) => d.baseKey === row.variantKey)
      : [];
    const docs =
      expanded.length > 0
        ? expanded.map((d) => ({ assetId: d.jobAssetId, variantKey: d.variantKey, displayName: d.name }))
        : row.jobAssetId
          ? [{ assetId: row.jobAssetId, variantKey: row.variantKey, displayName: row.displayName }]
          : [];

    for (const doc of docs) {
      const asset = assetById.get(doc.assetId);
      const fileName = asset?.fileName ?? "(asset no longer in the database)";
      const history = pushHistory.get(doc.assetId) ?? null;
      folder.files.push({
        fileName,
        spName: sanitizeFileName(fileName),
        variantKey: doc.variantKey,
        docType: asset?.docType ?? row.docType,
        displayName: doc.displayName ?? asset?.displayName ?? null,
        jobAssetId: doc.assetId,
        jobId: asset?.job?.id ?? asset?.jobId ?? null,
        jobCreatedAt: asset?.job?.createdAt ?? null,
        assetCreatedAt: asset?.createdAt ?? null,
        styleId: style.id,
        styleName: style.name,
        sharePointUrl: row.sharePointUrl,
        pushedAt: row.lastPushAt ?? row.updatedAt,
        firstPushAt: history?.first ?? null,
        lastPushAt: history?.last ?? null,
        pushEvents: history?.count ?? 0,
        emailedAt: row.sentAt,
        sharePointStatus: row.sharePointStatus,
      });
    }

    groups.set(poNumber, group);
  }

  // Post-pass: distinct styles per PO, and the name collisions inside each
  // folder. Two in-scope files sharing a sanitised name are ONE file in
  // SharePoint — worth saying before someone goes looking for the second.
  for (const group of groups.values()) {
    const seen = new Set<string>();
    for (const f of group.folders) {
      for (const file of f.files) seen.add(file.styleId);
      const counts = new Map<string, number>();
      for (const file of f.files) counts.set(file.spName, (counts.get(file.spName) ?? 0) + 1);
      f.collidingNames = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => n);
      f.files.sort((a, b) => a.spName.localeCompare(b.spName));
    }
    group.styles = seen.size;
  }

  // Oldest PO first — the deepest below the line is the most clearly wrong, and
  // it is also the order a person works an order backlog in.
  const ordered = [...groups.values()].sort(
    (a, b) => (a.poSeq ?? -1) - (b.poSeq ?? -1) || a.poNumber.localeCompare(b.poNumber),
  );

  if (asJson) {
    console.log(JSON.stringify({ cutoff, cutoffIsExplicit: explicit !== null, pos: ordered }, null, 2));
    await db.$disconnect();
    return;
  }

  const totalFiles = ordered.reduce((n, g) => n + g.folders.reduce((m, f) => m + f.files.length, 0), 0);
  const totalFolders = ordered.reduce((n, g) => n + g.folders.length, 0);

  console.log(
    `\nPre-cutoff supplier deliveries — supplier-send cutoff is PO >= ${cutoff}` +
      `${explicit === null ? " (inherited from the generation cutoff — not set explicitly)" : " (explicitly set)"}\n` +
      `${ordered.length} PO(s), ${totalFolders} folder(s), ${totalFiles} file(s)` +
      `${poArg ? ` — filtered to PO ${poArg}` : ""}${expandDocs ? " — slots expanded to documents" : ""}\n` +
      `\nREAD-ONLY REPORT. Nothing here deletes, renames or re-pushes anything.\n` +
      `Removal is a manual job in SharePoint; read the flags on each folder first.\n`,
  );

  for (const group of ordered) {
    const files = group.folders.reduce((n, f) => n + f.files.length, 0);
    console.log(`## PO ${group.poNumber} — ${files} file(s), ${group.styles} style(s)`);
    console.log(`   in scope because: ${group.reason}`);
    for (const folder of group.folders) {
      console.log(`   folder: ${folder.folderName}/${APPROVED_LAYOUTS_SUBFOLDER}`);
      console.log(`   supplier: ${folder.supplierName}  |  customer: ${folder.customerName}`);
      console.log(`   link: ${folder.folderUrl ?? "(no folder URL recorded on the queue row)"}`);
      if (folder.aboveCutoffRows > 0) {
        console.log(
          `   !! MIXED FOLDER — ${folder.aboveCutoffRows} delivered row(s) ABOVE the cutoff point at this` +
            ` same folder.\n      Do NOT delete the folder wholesale; remove the files listed below individually.`,
        );
      }
      if (folder.collidingNames.length > 0) {
        console.log(
          `   !! ${folder.collidingNames.length} file name(s) are shared by more than one document —` +
            ` SharePoint holds ONE\n      file per name, so the earlier writes were already overwritten.`,
        );
      }
      for (const f of folder.files) {
        const collided = folder.collidingNames.includes(f.spName) ? "  [NAME COLLISION]" : "";
        console.log(`     - ${f.spName}${collided}`);
        console.log(
          `         style: ${f.styleName} (${f.styleId})  |  output: ${f.displayName ?? f.docType} [${f.variantKey}]`,
        );
        console.log(
          `         job: ${f.jobId ?? "(unknown)"} generated ${fmt(f.assetCreatedAt ?? f.jobCreatedAt)}` +
            `  |  asset ${f.jobAssetId ?? "(gone)"}`,
        );
        console.log(
          `         pushed: ${fmt(f.lastPushAt ?? f.pushedAt)}` +
            (f.pushEvents > 1 ? ` (${f.pushEvents} push events, first ${fmt(f.firstPushAt)})` : "") +
            `  |  emailed to supplier: ${fmt(f.emailedAt)}`,
        );
        if (f.sharePointUrl) console.log(`         file: ${f.sharePointUrl}`);
      }
    }
    console.log("");
  }

  // The blind spot, stated rather than implied: the manual per-style push
  // buttons write files and an audit log but never a queue row, so they are
  // invisible to the listing above. Find below-cutoff styles that have a push
  // log and no queue row — those need checking by hand.
  const queuedStyleIds = new Set(inScope.map((r) => r.styleId));

  const loggedJobIds = [
    ...new Set(
      (
        await db.log.findMany({
          where: { message: { startsWith: "pushed " }, jobId: { not: null } },
          select: { jobId: true },
        })
      )
        .map((l) => l.jobId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const loggedStyleIds = [
    ...new Set(
      (
        await db.job.findMany({ where: { id: { in: loggedJobIds } }, select: { styleId: true } })
      ).map((j) => j.styleId),
    ),
  ].filter((id) => !queuedStyleIds.has(id));
  const manualOnlyStyles = await db.style.count({
    where: { id: { in: loggedStyleIds }, OR: [{ poSeq: null }, { poSeq: { lt: cutoff } }] },
  });

  console.log("---");
  console.log(`POs below the supplier-send cutoff with delivered files: ${ordered.length}`);
  console.log(`Supplier folders involved: ${totalFolders}`);
  console.log(`Files: ${totalFiles}`);
  console.log(
    `Mixed folders (also hold above-cutoff deliveries — never delete wholesale): ` +
      `${ordered.reduce((n, g) => n + g.folders.filter((f) => f.aboveCutoffRows > 0).length, 0)}`,
  );
  console.log(
    `Folders with name collisions among the in-scope files: ` +
      `${ordered.reduce((n, g) => n + g.folders.filter((f) => f.collidingNames.length > 0).length, 0)}`,
  );
  if (manualOnlyStyles > 0) {
    console.log(
      `\nNOT LISTED ABOVE: ${manualOnlyStyles} below-cutoff style(s) have a "pushed to supplier folder"\n` +
        `log entry but NO supplier-send queue row — the manual per-style push buttons never went through\n` +
        `the queue or the cutoff. Re-run with --json and cross-check those styles by hand if the cleanup\n` +
        `needs to be exhaustive.`,
    );
  }
  console.log(
    `\nThis script has no delete path. To remove a file, open the folder link above in SharePoint and\n` +
      `delete it there, one PO at a time, honouring the MIXED FOLDER and NAME COLLISION flags.`,
  );

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
