import { db } from "@/lib/db";
import { parseCustomerConfig } from "@/lib/customers/config";
import { getSupplierSendMinPo } from "@/lib/settings/app-settings";
import { listChildFiles } from "@/lib/sharepoint/supplier-folder";
import {
  resolveApprovedLayoutsFolder,
  reconcileStateMessage,
  type StyleRow,
} from "@/lib/sharepoint/reconcile-folder";
import {
  resolveCurrentFileNames,
  type CurrentNameResolution,
} from "@/lib/sharepoint/current-file-names";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import {
  buildPushedFileCheck,
  summarisePushedRows,
  type PushedFileSection,
  type PushedKindHistogram,
  type PushedRecord,
} from "./verdicts";

// =====================================================
// The RECORD-FIRST folder check: start from what this app actually pushed, and
// look only at those files.
//
// WHY THIS EXISTS ALONGSIDE /checks. The per-PO check and the sweep both reason
// FOLDER-FIRST — enumerate everything in the folder, compare it against what we
// expect to be there. That is the right shape for "is this order's folder
// complete", but it has two costs this surface does not pay:
//
//   1. It can reach a file we never created. A supplier's own document, the
//      buyer's paperwork, something a person dropped in by hand — folder-first
//      has to decide what to make of all of it, and a wrong decision there
//      proposes deleting somebody else's file. Starting from our own upload
//      records makes that MECHANICALLY IMPOSSIBLE: a file absent from
//      SupplierSendQueueItem is never looked at, never listed and never
//      actionable. The blind spot is the price — see below.
//   2. It has to build the expected set, which is the expensive half of
//      runPoChecks. Here we already know which file we uploaded and what its
//      layout calls it today, so there is nothing to derive.
//
// THE BLIND SPOT, STATED PLAINLY. This cannot see a file in a supplier folder
// that we have no record of pushing. That is a real gap and the folder-first
// sweep is the surface that covers it. A clean result here means "nothing WE
// put in this folder is wrong", never "this folder is clean" — every caller
// must say so where a person can read it.
//
// WHY sharePointUrl AND NOT JobAsset.fileName. The stamp is what generation
// FROZE; the URL is what the upload actually created. After a restamp the two
// disagree and the folder holds the second one. See PushedRecord.pushedName.
// =====================================================

// A record before its current name is known — that step needs the render
// context and so happens per folder, not in the inventory pass.
export type PendingRecord = Omit<PushedRecord, "currentName" | "currentNote"> & {
  jobAssetId: string | null;
};

export type PushedFolderScope = {
  supplierId: string;
  supplierName: string | null;
  poNumber: string;
  // Every style of ours that pushed into this folder. The folder is PO-scoped
  // and shared, so this is routinely more than one.
  styleIds: string[];
};

export type PushedFolderResult = {
  scope: PushedFolderScope;
  // "ok" — the folder was read and the section is a real answer.
  // Anything else — the folder could not be read, and the section is EMPTY but
  // that emptiness means nothing. Never render an unreadable folder as clean.
  state: "ok" | "unreadable";
  stateNote: string | null;
  folderUrl: string | null;
  section: PushedFileSection | null;
  histogram: PushedKindHistogram;
};

// One queue row, joined to the style that owns it. Loaded in one query rather
// than per folder: 2,700-odd rows is one round trip, and doing it per folder
// would be 600.
type QueueRow = {
  id: string;
  styleId: string;
  variantKey: string;
  jobAssetId: string | null;
  sharePointUrl: string | null;
  sharePointFolderUrl: string | null;
};

// The file name we uploaded under, read off the recorded URL.
//
// Graph webUrls are percent-encoded and may carry a query string; both have to
// come off or the name will never match a listing. A URL we cannot read a name
// out of yields null and the record is dropped with a note — guessing a name
// here would invent a file that does not exist.
export function fileNameFromUrl(url: string | null): string | null {
  if (!url) return null;
  const withoutQuery = url.split("?")[0];
  const last = withoutQuery.split("/").pop();
  if (!last) return null;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // A malformed escape sequence: keep the raw segment rather than throwing.
    decoded = last;
  }
  const trimmed = decoded.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// The last run of digits in a PO number — the same rule the cutoff comparisons
// use everywhere else. "C-PO 63320" and "63320" both yield 63320; a PO with no
// digits yields null and is treated as in scope, never as below the cutoff.
export function poSeqOf(poNumber: string | null): number | null {
  if (!poNumber) return null;
  const m = String(poNumber).match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) : null;
}

// Why a record has no current name, in words a person can act on. Never a
// guess: renaming a file onto a guessed name is how the wrong artwork ends up
// under the right one.
function currentNoteFor(r: CurrentNameResolution | undefined): string {
  if (!r) return "this upload has no approved asset behind it any more, so its name cannot be resolved";
  switch (r.kind) {
    case "template-default":
      return "its layout has no file-name template, so the generated default stands";
    case "no-template":
      return "a framing page — it never had a file-name template";
    case "unresolvable":
      return r.reason;
    default:
      return "no current name could be resolved";
  }
}

export type PushedScanInventory = {
  folders: PushedFolderScope[];
  // queueItemId -> the record, minus currentName which needs the render context.
  recordsByFolder: Map<string, PendingRecord[]>;
  // Records we could not use, with the reason. Surfaced rather than dropped
  // silently: a record with no readable URL is a gap in our own bookkeeping.
  skipped: { queueItemId: string; reason: string }[];
};

const folderKey = (supplierId: string, poNumber: string) => `${supplierId}::${poNumber}`;

// Everything this app has pushed, grouped into the folders it went into.
// DB only — no Graph, so this is cheap and safe to call to size a run.
export async function loadPushedInventory(): Promise<PushedScanInventory> {
  const rows: QueueRow[] = await db.supplierSendQueueItem.findMany({
    where: { sharePointStatus: "UPLOADED" },
    select: {
      id: true,
      styleId: true,
      variantKey: true,
      jobAssetId: true,
      sharePointUrl: true,
      sharePointFolderUrl: true,
    },
  });

  const styleIds = [...new Set(rows.map((r) => r.styleId).filter(Boolean))];
  const styles = await db.style.findMany({
    where: { id: { in: styleIds } },
    select: {
      id: true,
      name: true,
      poNumber: true,
      supplierId: true,
      supplier: { select: { name: true } },
    },
  });
  const styleById = new Map(styles.map((s) => [s.id, s]));

  const recordsByFolder = new Map<string, PendingRecord[]>();
  const scopes = new Map<string, PushedFolderScope>();
  const skipped: { queueItemId: string; reason: string }[] = [];

  for (const row of rows) {
    const style = styleById.get(row.styleId);
    if (!style) {
      skipped.push({ queueItemId: row.id, reason: "the style this was pushed for no longer exists" });
      continue;
    }
    if (!style.supplierId || !style.poNumber) {
      skipped.push({
        queueItemId: row.id,
        reason: "the style has no supplier or no PO number, so its folder cannot be resolved",
      });
      continue;
    }
    const pushedName = fileNameFromUrl(row.sharePointUrl);
    if (!pushedName) {
      skipped.push({
        queueItemId: row.id,
        reason: "no file name could be read from the recorded upload URL",
      });
      continue;
    }

    const k = folderKey(style.supplierId, style.poNumber);
    let scope = scopes.get(k);
    if (!scope) {
      scope = {
        supplierId: style.supplierId,
        supplierName: style.supplier?.name ?? null,
        poNumber: style.poNumber,
        styleIds: [],
      };
      scopes.set(k, scope);
    }
    if (!scope.styleIds.includes(style.id)) scope.styleIds.push(style.id);

    const list = recordsByFolder.get(k) ?? [];
    list.push({
      queueItemId: row.id,
      styleId: style.id,
      styleName: style.name,
      docType: row.variantKey,
      jobAssetId: row.jobAssetId,
      displayName: null,
      poNumber: style.poNumber,
      poSeq: poSeqOf(style.poNumber),
      pushedName,
    });
    recordsByFolder.set(k, list);
  }

  return { folders: [...scopes.values()], recordsByFolder, skipped };
}

// One folder: resolve it, list it once, and judge only our own records.
//
// Every Graph failure is caught and mapped to "unreadable". A 403, a throttle
// or a blip must never be allowed to read as "nothing we pushed is wrong here"
// — that is the one wrong answer this surface could give that a person would
// act on.
export async function scanPushedFolder(
  scope: PushedFolderScope,
  records: PendingRecord[],
  opts?: { minPo?: number | null; variantsAlreadyFresh?: boolean },
): Promise<PushedFolderResult> {
  const minPo = opts?.minPo !== undefined ? opts.minPo : await getSupplierSendMinPo().catch(() => null);

  const empty: PushedFolderResult = {
    scope,
    state: "unreadable",
    stateNote: null,
    folderUrl: null,
    section: null,
    histogram: {},
  };

  // The folder is resolved from any one of its styles — they share it, which is
  // the whole reason this page groups by (supplier, PO) rather than by style.
  const styleRow = await db.style
    .findUnique({
      where: { id: scope.styleIds[0] },
      select: {
        id: true,
        name: true,
        poNumber: true,
        supplierId: true,
        supplierPoFolderName: true,
        customer: { select: { config: true } },
        supplier: { select: { name: true, sharepointUrl: true } },
      },
    })
    .catch(() => null);

  if (!styleRow) return { ...empty, stateNote: "the style this folder was resolved from is gone" };

  const target = await resolveApprovedLayoutsFolder({
    id: styleRow.id,
    name: styleRow.name,
    poNumber: styleRow.poNumber,
    supplierId: styleRow.supplierId,
    supplierPoFolderName: styleRow.supplierPoFolderName,
    supplierName: styleRow.supplier?.name ?? null,
    supplierFolderUrl: styleRow.supplier?.sharepointUrl ?? null,
    skipSupplierDelivery: parseCustomerConfig(styleRow.customer.config).skipSupplierDelivery,
  } satisfies StyleRow).catch(() => null);

  if (!target || target.state !== "ok" || !target.driveId || !target.leafItemId) {
    return {
      ...empty,
      folderUrl: target?.folderUrl ?? null,
      stateNote:
        (target?.ambiguousMatches.length ?? 0) > 1
          ? "several folders match this PO, so we cannot say which one holds these files"
          : (target ? reconcileStateMessage(target.state) : "the supplier's folder for this PO could not be opened"),
    };
  }

  let present;
  try {
    present = await listChildFiles(target.driveId, target.leafItemId);
  } catch {
    return { ...empty, folderUrl: target.folderUrl, stateNote: "the folder could not be listed" };
  }

  // What each document's layout calls it TODAY, per style. Resolved per style
  // because the render context is a function of the style's own data; the
  // variant catalogue is refreshed once for the whole folder.
  if (!opts?.variantsAlreadyFresh) await ensureLayoutVariantsLoaded(true);

  const withCurrent: PushedRecord[] = [];
  const byStyle = new Map<string, typeof records>();
  for (const r of records) {
    const list = byStyle.get(r.styleId) ?? [];
    list.push(r);
    byStyle.set(r.styleId, list);
  }

  for (const [styleId, styleRecords] of byStyle) {
    const names = await resolveCurrentFileNames(
      styleId,
      styleRecords
        .filter((r): r is typeof r & { jobAssetId: string } => Boolean(r.jobAssetId))
        .map((r) => ({ jobAssetId: r.jobAssetId, variantKey: r.docType })),
      { variantsAlreadyFresh: true },
    ).catch(() => new Map<string, CurrentNameResolution>());

    for (const r of styleRecords) {
      const resolution = r.jobAssetId ? names.get(r.jobAssetId) : undefined;
      const current = resolution?.kind === "resolved" ? resolution.fileName : null;
      withCurrent.push({
        ...r,
        currentName: current,
        currentNote: current ? null : currentNoteFor(resolution),
      });
    }
  }

  const section = buildPushedFileCheck({
    records: withCurrent,
    present: present.map((f) => ({
      fileName: f.name,
      itemId: f.id,
      webUrl: f.webUrl ?? null,
      size: f.size ?? null,
      lastModifiedAt: f.lastModifiedAt ?? null,
    })),
    minPo,
  });

  return {
    scope,
    state: "ok",
    stateNote: null,
    folderUrl: target.folderUrl,
    section,
    histogram: summarisePushedRows([...section.flagged, ...section.reported]),
  };
}
