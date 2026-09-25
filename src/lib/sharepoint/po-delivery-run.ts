import { listChildFiles, sanitizeFileName, deleteDriveItem, SharePointWriteForbiddenError } from "./supplier-folder";
import { missingGraphEnvVars } from "./auth";
import { APPROVED_LAYOUTS_SUBFOLDER } from "./supplier-folder-names";
import {
  loadExpectedFiles,
  resolveApprovedLayoutsFolder,
  precheckReconcileState,
  reconcileStateMessage,
  ReconcileApplyError,
  type ExpectedFile,
  type StyleRow,
  type ReconcileState,
} from "./reconcile-folder";
import {
  buildDeliveryLedger,
  isFullyDelivered,
  deliveryHeadline,
  type PoDeliveryReport,
  type DeliveryFile,
  type PoDeliveryTotals,
} from "./po-delivery";

// =====================================================
// Composition + I/O for the PO delivery ledger: resolve the folder ONCE, union
// every style on the purchase order, list the folder, hand both to the pure
// counting logic in po-delivery.ts. Then, separately, repair what is
// repairable.
//
// Folder resolution is resolveApprovedLayoutsFolder — the SAME chain the push,
// the verify sweep and the style panel use. If this module resolved the folder
// its own way the two surfaces would eventually disagree about which folder is
// canonical and each would report the other's files as missing.
//
// UNRESOLVABLE-FOLDER DISCIPLINE, inherited wholesale: a 403, a throttle, an
// unresolvable sharing link or an ambiguous PO folder must NEVER read as "the
// files are gone". Each keeps its own state and NO ledger is produced. On a
// fleet list this matters more than on one style page — a sweep that recorded
// "0 of 68 delivered" for every PO during a Graph outage would send someone
// re-pushing thousands of files that were never missing.
// =====================================================

const EMPTY_TOTALS: PoDeliveryTotals = {
  expectedDocs: 0,
  deliveredDocs: 0,
  renamedDocs: 0,
  missingDocs: 0,
  collisionDocs: 0,
  collisionNames: 0,
  strayFiles: 0,
  staleFiles: 0,
};

export type PoStyleRow = StyleRow & { poSeq: number | null };

// Every live style on one (supplier, PO). This is the unit the whole module
// works in: the folder is keyed on that pair, so styles is what the folder
// holds — not the other way round.
export async function loadPoStyles(supplierId: string, poNumber: string): Promise<PoStyleRow[]> {
  const { db } = await import("@/lib/db");
  const { parseCustomerConfig } = await import("@/lib/customers/config");
  const rows = await db.style.findMany({
    where: { supplierId, poNumber, archivedAt: null, deletedAt: null },
    select: {
      id: true,
      name: true,
      poNumber: true,
      poSeq: true,
      supplierId: true,
      supplierPoFolderName: true,
      customer: { select: { config: true } },
      supplier: { select: { name: true, sharepointUrl: true } },
    },
    orderBy: { name: "asc" },
  });
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    poNumber: s.poNumber,
    poSeq: s.poSeq,
    supplierId: s.supplierId,
    supplierPoFolderName: s.supplierPoFolderName,
    supplierName: s.supplier?.name ?? null,
    supplierFolderUrl: s.supplier?.sharepointUrl ?? null,
    skipSupplierDelivery: parseCustomerConfig(s.customer.config).skipSupplierDelivery,
  }));
}

// Which style's folder pin wins when the PO's styles disagree. A pin is an
// operator's manual answer to an ambiguous PO folder, so a style that HAS one
// is the one that knows where the folder is; ties break on style name so the
// choice is deterministic across re-checks.
function representativeStyle(styles: PoStyleRow[]): PoStyleRow | null {
  if (styles.length === 0) return null;
  return styles.find((s) => s.supplierPoFolderName?.trim()) ?? styles[0];
}

export async function checkPoDelivery(input: {
  supplierId: string;
  poNumber: string;
}): Promise<PoDeliveryReport> {
  const styles = await loadPoStyles(input.supplierId, input.poNumber);
  const rep = representativeStyle(styles);

  const shell = (state: ReconcileState, extra?: Partial<PoDeliveryReport>): PoDeliveryReport => ({
    poNumber: input.poNumber,
    supplierId: input.supplierId,
    supplierName: rep?.supplierName ?? null,
    state,
    message: reconcileStateMessage(state, {
      supplierName: rep?.supplierName,
      poNumber: input.poNumber,
      missingEnvVars: missingGraphEnvVars(),
    }),
    folderUrl: null,
    folderPath: null,
    poFolderUrl: null,
    styles: [],
    totals: EMPTY_TOTALS,
    names: [],
    strayFiles: [],
    staleFiles: [],
    checkedAt: new Date().toISOString(),
    ...extra,
  });

  if (!rep) return shell("style-not-found");

  // Graph credentials only — the PO folder is reached through the supplier's
  // sharing link, never through SHAREPOINT_SITE_ID. See auth.ts.
  const { isGraphConfigured } = await import("./auth");
  const blocked = precheckReconcileState({
    styleFound: true,
    hasSupplier: rep.supplierName != null,
    supplierFolderUrl: rep.supplierFolderUrl,
    poNumber: rep.poNumber,
    // A PO is skipped only when EVERY style on it is a self-delivering
    // customer. One style that does ship to the supplier means the folder is
    // real and has to be audited.
    skipSupplierDelivery: styles.every((s) => s.skipSupplierDelivery),
    sharepointConfigured: isGraphConfigured(),
  });
  if (blocked) return shell(blocked);

  const target = await resolveApprovedLayoutsFolder(rep);
  const located = {
    folderUrl: target.folderUrl,
    poFolderUrl: target.poFolderUrl,
    folderPath: target.poFolderName ? `${target.poFolderName} / ${APPROVED_LAYOUTS_SUBFOLDER}` : null,
  };
  if (target.state !== "ok" && target.state !== "subfolder-missing") {
    return shell(target.state, located);
  }

  // Expected set: every style on the PO, resolved against its layouts' CURRENT
  // templates. The variant force-refresh happens once, here, rather than per
  // style — it re-reads every published layout.
  const { ensureLayoutVariantsLoaded } = await import("@/lib/output-layouts/variants");
  await ensureLayoutVariantsLoaded(true);

  const expected: ExpectedFile[] = [];
  for (const s of styles) {
    try {
      expected.push(...(await loadExpectedFiles({ id: s.id, name: s.name }, true, true)));
    } catch (err) {
      // One unreadable style must not sink the PO's ledger — but it WOULD
      // understate the expectation, so it is logged rather than swallowed.
      console.warn(`[po-delivery] expected-set failed for style ${s.id} on ${input.poNumber}:`, err);
    }
  }

  let present: DeliveryFile[] = [];
  if (target.state === "ok") {
    try {
      const files = await listChildFiles(target.driveId as string, target.leafItemId as string);
      present = files.map((f) => ({
        fileName: f.name,
        itemId: f.id,
        webUrl: f.webUrl,
        size: f.size,
        lastModifiedAt: f.lastModifiedAt,
      }));
    } catch {
      return shell("unavailable", located);
    }
  }

  const ledger = buildDeliveryLedger({ expected, present });

  return shell(target.state, {
    ...located,
    styles: ledger.styles,
    totals: ledger.totals,
    names: ledger.names,
    strayFiles: ledger.strayFiles,
    staleFiles: ledger.staleFiles,
  });
}

// -----------------------------------------------------
// Repair — the self-healing half.
// -----------------------------------------------------

export type PoRepairResult = {
  poNumber: string;
  pushed: number;
  restamped: number;
  staleDeleted: number;
  // Documents deliberately NOT repaired because pushing them would just
  // overwrite a sibling. Reported, never silently skipped.
  blockedByCollision: number;
  perStyle: Array<{ styleId: string; styleName: string; pushed: number; error: string | null }>;
  notes: string[];
};

// Push every document this PO is missing (or is sitting under an old name),
// then remove the old copies nothing needs any more.
//
// WHAT IT WILL NOT DO. A document whose name is claimed by another document is
// SKIPPED. Pushing it would overwrite the sibling that currently occupies that
// name — turning one missing document into a different missing document, over
// and over, every time the sweep ran. A collision is a naming defect and the
// repair for it is to make the template specific enough; the ledger says which
// token is missing.
//
// ORDER. Restamp → push → delete. The supplier's folder is never left without a
// document: the new name is uploaded before the old file goes, and a push that
// fails leaves the old file exactly where it was.
export async function repairPoDelivery(input: {
  supplierId: string;
  poNumber: string;
  userId?: string;
}): Promise<PoRepairResult> {
  const { db } = await import("@/lib/db");
  const { pushApprovedAssetsToSupplier, SupplierPushError } = await import("./push-to-supplier");
  const { resolveCurrentFileNames } = await import("./current-file-names");

  const report = await checkPoDelivery({ supplierId: input.supplierId, poNumber: input.poNumber });
  if (report.state !== "ok" && report.state !== "subfolder-missing") {
    throw new ReconcileApplyError(409, report.message);
  }

  const result: PoRepairResult = {
    poNumber: input.poNumber,
    pushed: 0,
    restamped: 0,
    staleDeleted: 0,
    blockedByCollision: 0,
    perStyle: [],
    notes: [],
  };

  // Repairable = a name exactly ONE document wants, which is absent or present
  // only under an old name. Everything else is either fine or a naming defect.
  const repairable = report.names.filter((g) => g.wanted === 1 && !g.present);
  const colliding = report.names.filter((g) => g.wanted > 1);
  result.blockedByCollision = colliding.reduce((a, g) => a + g.wanted - 1, 0);
  for (const g of colliding) {
    result.notes.push(
      `“${g.fileName}” — ${g.wanted} documents want this name and the folder can only hold one: ${g.distinguishers.join("; ")}. Make the layout's file name specific enough, then re-run this repair.`,
    );
  }

  if (repairable.length === 0) {
    if (result.blockedByCollision === 0) result.notes.push("Nothing to repair — every document is in the folder.");
    return result;
  }

  const docs = repairable.flatMap((g) => g.documents);
  const byStyle = new Map<string, typeof docs>();
  for (const d of docs) byStyle.set(d.styleId, [...(byStyle.get(d.styleId) ?? []), d]);

  for (const [styleId, styleDocs] of byStyle) {
    const styleName = styleDocs[0].styleName;
    // ---- Restamp the ones whose template moved on, so the push writes the
    // current name rather than re-uploading the stale one.
    const stale = styleDocs.filter((d) => d.status === "renamed" || d.previousFileName != null);
    if (stale.length > 0) {
      const names = await resolveCurrentFileNames(
        styleId,
        stale.map((d) => ({ jobAssetId: d.jobAssetId, variantKey: d.variantKey })),
        { variantsAlreadyFresh: true },
      );
      for (const d of stale) {
        const r = names.get(d.jobAssetId);
        if (r?.kind !== "resolved") continue;
        await db.jobAsset
          .update({ where: { id: d.jobAssetId }, data: { fileName: r.fileName } })
          .then(() => {
            result.restamped += 1;
          })
          .catch(() => {});
      }
    }

    try {
      const push = await pushApprovedAssetsToSupplier({
        styleId,
        assetIds: styleDocs.map((d) => d.jobAssetId),
        userId: input.userId,
      });
      result.pushed += push.pushed.length;
      result.perStyle.push({ styleId, styleName, pushed: push.pushed.length, error: null });
    } catch (err) {
      const msg = err instanceof SupplierPushError ? err.message : (err as Error).message;
      // One style's push failing must not abandon the rest of the PO — that is
      // the whole reason the sweep works folder-by-folder rather than all-or-
      // nothing.
      result.perStyle.push({ styleId, styleName, pushed: 0, error: msg });
      result.notes.push(`“${styleName}” — ${msg}`);
    }
  }

  // ---- Delete the old copies, now that the new names are up. Re-checked
  // against a FRESH ledger: the push just changed the folder, and deleting on
  // the strength of the pre-push picture could remove a file that is now the
  // only copy of something.
  const after = await checkPoDelivery({ supplierId: input.supplierId, poNumber: input.poNumber });
  if (after.state === "ok") {
    const target = await resolveApprovedLayoutsFolder(
      representativeStyle(await loadPoStyles(input.supplierId, input.poNumber)) as StyleRow,
    );
    if (target.state === "ok" && target.driveId) {
      for (const f of after.staleFiles) {
        try {
          const del = await deleteDriveItem(target.driveId, f.itemId);
          if (del.deleted || del.alreadyGone) result.staleDeleted += 1;
        } catch (err) {
          result.notes.push(
            err instanceof SharePointWriteForbiddenError
              ? `Couldn't remove the old file “${f.fileName}” — SharePoint refused the delete (403). The new files are uploaded.`
              : `Couldn't remove the old file “${f.fileName}” — ${(err as Error).message.slice(0, 80)}`,
          );
        }
      }
    }
  }

  await writeRepairLog(input.poNumber, result, input.userId);
  return result;
}

async function writeRepairLog(poNumber: string, r: PoRepairResult, userId?: string): Promise<void> {
  try {
    const { db } = await import("@/lib/db");
    await db.log.create({
      data: {
        jobId: null,
        level: "INFO",
        message:
          `PO delivery repair · ${poNumber} · pushed ${r.pushed}, restamped ${r.restamped}, removed ${r.staleDeleted} stale file(s)` +
          (r.blockedByCollision > 0 ? ` · ${r.blockedByCollision} blocked by a file-name clash` : "") +
          (userId ? ` · by user ${userId}` : ""),
        payload: { ...r },
      },
    });
  } catch {
    /* best-effort */
  }
}

// -----------------------------------------------------
// The fleet sweep — what makes "are ALL files delivered?" answerable.
// -----------------------------------------------------

export type PoDeliverySweepResult = {
  checked: number;
  fullyDelivered: number;
  withShortfall: number;
  unresolvable: number;
  skipped: number;
  // The deadline cut the slice short. Reported rather than silent: a caller
  // that keeps hitting this is under-provisioned, and a sweep that quietly
  // stops early looks identical to one that had nothing left to do.
  ranOutOfTime: boolean;
  // Folders still waiting after this slice — the fleet's remaining backlog.
  remaining: number;
};

// Every (supplier, PO) worth auditing: has a supplier, has a PO at or above the
// supplier-send cutoff (below it nothing is deliverable by policy, so a
// shortfall there is not a finding), and is not archived.
export async function listDeliverablePoKeys(): Promise<Array<{ supplierId: string; poNumber: string; poSeq: number | null }>> {
  const { db } = await import("@/lib/db");
  const { getSupplierSendMinPo } = await import("@/lib/settings/app-settings");
  const minPo = await getSupplierSendMinPo().catch(() => null);

  const rows = await db.style.findMany({
    where: {
      archivedAt: null,
      deletedAt: null,
      supplierId: { not: null },
      poNumber: { not: null },
      ...(minPo != null ? { poSeq: { gte: minPo } } : {}),
    },
    select: { supplierId: true, poNumber: true, poSeq: true },
    distinct: ["supplierId", "poNumber"],
    orderBy: [{ poSeq: "desc" }],
  });
  return rows.map((r) => ({
    supplierId: r.supplierId as string,
    poNumber: r.poNumber as string,
    poSeq: r.poSeq,
  }));
}

// Check the least-recently-checked folders, bounded per tick. Graph is the
// budget here — a few hundred folders at ~5 calls each is far more than one
// cron tick should spend, so the sweep rotates and every folder comes round.
export async function sweepPoDelivery(opts?: {
  limit?: number;
  // Stop starting new folders once this epoch-ms passes. `limit` bounds the
  // Graph SPEND; this bounds the wall CLOCK, and they are not the same bound —
  // one slow supplier tenant can make five folders take longer than fifty fast
  // ones. Needed because this sweep now also runs inside the shared 5-minute
  // job-runner tick, where overrunning would eat the generation drain's budget.
  // A folder already in flight always finishes: abandoning it mid-way would
  // record nothing and re-do the same Graph calls next tick.
  deadlineAt?: number;
}): Promise<PoDeliverySweepResult> {
  const { db } = await import("@/lib/db");
  const limit = opts?.limit ?? 25;

  const keys = await listDeliverablePoKeys();
  const existing = await db.poDeliveryCheck.findMany({
    select: { supplierId: true, poNumber: true, checkedAt: true },
  });
  const lastChecked = new Map(existing.map((e) => [`${e.supplierId}::${e.poNumber}`, e.checkedAt.getTime()]));

  // Never-checked first (they are the unknowns), then oldest-checked.
  const queue = [...keys].sort(
    (a, b) =>
      (lastChecked.get(`${a.supplierId}::${a.poNumber}`) ?? 0) -
      (lastChecked.get(`${b.supplierId}::${b.poNumber}`) ?? 0),
  );

  const result: PoDeliverySweepResult = {
    checked: 0,
    fullyDelivered: 0,
    withShortfall: 0,
    unresolvable: 0,
    skipped: 0,
    ranOutOfTime: false,
    remaining: Math.max(0, queue.length - limit),
  };

  for (const k of queue.slice(0, limit)) {
    // Out of time. The remaining folders keep their old checkedAt, so the
    // least-recently-checked ordering hands them straight back on the next
    // tick — a truncated sweep loses nothing but this tick's progress.
    if (opts?.deadlineAt != null && Date.now() >= opts.deadlineAt) {
      result.ranOutOfTime = true;
      break;
    }
    let report: PoDeliveryReport;
    try {
      report = await checkPoDelivery({ supplierId: k.supplierId, poNumber: k.poNumber });
    } catch (err) {
      console.warn(`[po-delivery] sweep failed for ${k.poNumber}:`, err);
      result.skipped += 1;
      continue;
    }
    result.checked += 1;
    const listable = report.state === "ok" || report.state === "subfolder-missing";
    if (!listable) result.unresolvable += 1;
    else if (isFullyDelivered(report.totals)) result.fullyDelivered += 1;
    else result.withShortfall += 1;

    await db.poDeliveryCheck
      .upsert({
        where: { supplierId_poNumber: { supplierId: k.supplierId, poNumber: k.poNumber } },
        create: { supplierId: k.supplierId, poNumber: k.poNumber, poSeq: k.poSeq, ...snapshot(report, listable) },
        update: { poSeq: k.poSeq, ...snapshot(report, listable) },
      })
      .catch((err) => {
        console.warn(`[po-delivery] could not record ${k.poNumber}:`, err);
      });
  }

  return result;
}

// The row a fleet list reads. Deliberately counts + one sentence, not the whole
// ledger: the list has to render hundreds of rows without a Graph call, and the
// detail page re-checks live anyway.
function snapshot(report: PoDeliveryReport, listable: boolean) {
  return {
    supplierName: report.supplierName,
    state: report.state,
    message: listable ? deliveryHeadline(report.totals) : report.message,
    folderUrl: report.folderUrl,
    styleCount: report.styles.length,
    expectedDocs: report.totals.expectedDocs,
    deliveredDocs: report.totals.deliveredDocs,
    missingDocs: report.totals.missingDocs,
    renamedDocs: report.totals.renamedDocs,
    collisionDocs: report.totals.collisionDocs,
    strayFiles: report.totals.strayFiles,
    staleFiles: report.totals.staleFiles,
    fullyDelivered: listable && isFullyDelivered(report.totals),
    checkedAt: new Date(report.checkedAt),
  };
}

export { sanitizeFileName };
