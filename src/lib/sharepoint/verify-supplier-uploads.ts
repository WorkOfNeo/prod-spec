import { db } from "@/lib/db";
import { getSupplierBatchSendEnabled } from "@/lib/settings/app-settings";
import {
  resolveSupplierFolder,
  findChildFolder,
  listChildFileNames,
  type ResolvedFolder,
} from "./supplier-folder";
import { supplierParentFolderName, APPROVED_LAYOUTS_SUBFOLDER } from "./supplier-folder-names";

// =====================================================
// Self-heal verify for supplier-folder uploads (WS4). A queue row is stamped
// UPLOADED the moment a Graph PUT doesn't throw, and the recurring sweep then
// skips it forever (sharePointStatus != "UPLOADED"). So a file that was really
// written but later moved (an earlier folder-naming scheme), got removed by the
// legacy-folder cleanup, or landed somewhere the supplier can't browse stays
// "uploaded" in the app with nothing ever re-checking it.
//
// This pass re-opens each UPLOADED row's CURRENT expected location — the
// supplier's "<PO> - <customer> - <supplier>/APPROVED LAYOUTS/" folder — lists
// it once, and confirms every file the push would have written is actually
// there:
//
//   • all present            → stamp sharePointVerifiedAt, refresh the folder URL.
//   • folder OK, file missing → AUTO RE-ARM to PENDING (clears url + attempts) so
//                               the normal upload sweep re-uploads it. This is the
//                               self-heal.
//   • folder unresolvable /   → LEFT UNTOUCHED. A 403/network blip or a supplier
//     403 / transient error     link that momentarily won't resolve must NEVER be
//                               read as "file missing" — otherwise one permission
//                               hiccup would wipe every status at once.
//
// Bounded per run (budget) and TTL-gated (a row is re-checked at most once a
// day) so Graph load stays low. Flag-gated by the same supplierBatchSendEnabled
// master switch as the push. Run BEFORE the push in a tick so a re-armed row
// re-uploads the same tick.
// =====================================================

// Re-verify each UPLOADED row at most once per this window.
export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
// Rows checked per run — caps the Graph calls a single tick makes.
const DEFAULT_BUDGET = 60;

export type SupplierVerifySweep = {
  scanned: number; // UPLOADED rows examined this run
  verified: number; // confirmed present in the folder
  healed: number; // folder resolved but file missing → re-armed to PENDING
  unresolved: number; // couldn't resolve/list the folder (permission/transient) — left as-is
};

const EMPTY: SupplierVerifySweep = { scanned: 0, verified: 0, healed: 0, unresolved: 0 };

export async function verifySupplierUploads(opts?: {
  budget?: number;
  styleIds?: string[];
}): Promise<SupplierVerifySweep> {
  if (!(await getSupplierBatchSendEnabled())) return { ...EMPTY };

  const budget = opts?.budget ?? DEFAULT_BUDGET;
  const cutoff = new Date(Date.now() - VERIFY_TTL_MS);

  const items = await db.supplierSendQueueItem.findMany({
    where: {
      sentAt: null,
      sharePointStatus: "UPLOADED",
      OR: [{ sharePointVerifiedAt: null }, { sharePointVerifiedAt: { lt: cutoff } }],
      ...(opts?.styleIds && opts.styleIds.length > 0 ? { styleId: { in: opts.styleIds } } : {}),
    },
    select: { id: true, styleId: true, variantKey: true, jobAssetId: true },
    orderBy: { sharePointVerifiedAt: { sort: "asc", nulls: "first" } },
    take: budget,
  });
  if (items.length === 0) return { ...EMPTY };

  const byStyle = new Map<string, typeof items>();
  for (const it of items) {
    const arr = byStyle.get(it.styleId) ?? [];
    arr.push(it);
    byStyle.set(it.styleId, arr);
  }

  const styleRows = await db.style.findMany({
    where: { id: { in: [...byStyle.keys()] } },
    select: {
      id: true,
      name: true,
      poNumber: true,
      customer: { select: { name: true } },
      supplier: { select: { name: true, sharepointUrl: true } },
    },
  });
  const styleById = new Map(styleRows.map((s) => [s.id, s]));

  // Fallback expected file name for a row when the current-outputs walk can't
  // resolve its slot (the exact bytes the push wrote live on the JobAsset).
  const assetIds = items.map((i) => i.jobAssetId).filter((x): x is string => x != null);
  const assetNameById = new Map<string, string>();
  if (assetIds.length > 0) {
    const assets = await db.jobAsset.findMany({
      where: { id: { in: assetIds } },
      select: { id: true, fileName: true },
    });
    for (const a of assets) assetNameById.set(a.id, a.fileName);
  }

  // Per-run caches — styles under one PO share the same supplier root and the
  // same "APPROVED LAYOUTS" subfolder, so resolve/list each at most once.
  const rootCache = new Map<string, ResolvedFolder | null>();
  const listingCache = new Map<string, Set<string>>();

  const sweep: SupplierVerifySweep = { ...EMPTY };
  const now = () => new Date();

  for (const [styleId, styleItems] of byStyle) {
    sweep.scanned += styleItems.length;
    const style = styleById.get(styleId);
    const sharingUrl = style?.supplier?.sharepointUrl?.trim();
    // No supplier folder on file → we can't locate anything to verify against.
    // Leave the rows as-is (re-arming would only settle them SKIPPED).
    if (!style || !style.supplier || !sharingUrl) {
      sweep.unresolved += styleItems.length;
      continue;
    }

    // Resolve supplier root (cached). A failure here is transient/permission —
    // never treat it as "files missing".
    let root: ResolvedFolder | null;
    if (rootCache.has(sharingUrl)) {
      root = rootCache.get(sharingUrl) ?? null;
    } else {
      try {
        root = await resolveSupplierFolder(sharingUrl);
      } catch {
        root = null;
      }
      rootCache.set(sharingUrl, root);
    }
    if (!root) {
      sweep.unresolved += styleItems.length;
      continue;
    }

    // Expected file names per base variantKey — mirror the push's slot→docs
    // expansion so the names we look for are exactly the ones it wrote.
    const expectedByBase = new Map<string, string[]>();
    try {
      const { getCurrentOutputsForStyle } = await import("@/lib/outputs/current-outputs");
      const outputs = await getCurrentOutputsForStyle(styleId);
      for (const o of outputs) {
        if (o.jobAssetId == null || o.fileName == null) continue;
        if (o.reviewStatus !== "APPROVED" || o.placeholderCount > 0) continue;
        const b = o.variantKey.split("#")[0] || `doc:${o.docType}`;
        const arr = expectedByBase.get(b) ?? [];
        arr.push(o.fileName);
        expectedByBase.set(b, arr);
      }
    } catch {
      // fall back to the stored asset name below
    }

    // Locate + list the "<PO> - <customer> - <supplier>/APPROVED LAYOUTS/"
    // subfolder (cached per resolved folder). null parent/leaf → the folder
    // genuinely does not exist → files are missing → these rows heal. A thrown
    // error (403/transient) → unresolved, left untouched.
    const parentName = supplierParentFolderName({
      poNumber: style.poNumber,
      styleName: style.name,
      customerName: style.customer.name,
      supplierName: style.supplier.name,
    });
    const cacheKey = `${root.driveId}:${parentName}`;

    let names: Set<string> | null = null;
    let folderWebUrl: string | null = null;
    let folderExists = true;
    if (listingCache.has(cacheKey)) {
      names = listingCache.get(cacheKey)!;
      folderWebUrl = null; // webUrl not re-derived on cache hit; verified rows keep their existing folder URL
    } else {
      try {
        const parent = await findChildFolder(root.driveId, root.itemId, parentName);
        const leaf = parent
          ? await findChildFolder(root.driveId, parent.id, APPROVED_LAYOUTS_SUBFOLDER)
          : null;
        if (!leaf) {
          folderExists = false;
        } else {
          folderWebUrl = leaf.webUrl;
          names = await listChildFileNames(root.driveId, leaf.id);
          listingCache.set(cacheKey, names);
        }
      } catch {
        // Permission/transient — cannot conclude anything.
        sweep.unresolved += styleItems.length;
        continue;
      }
    }

    const healIds: string[] = [];
    const verifyIds: string[] = [];
    for (const item of styleItems) {
      const expected =
        expectedByBase.get(item.variantKey) ??
        (item.jobAssetId ? [assetNameById.get(item.jobAssetId)].filter((x): x is string => !!x) : []);
      // Can't determine what file to look for → don't touch it.
      if (expected.length === 0) {
        sweep.unresolved += 1;
        continue;
      }
      const present = folderExists && names != null && expected.every((n) => names!.has(n.toLowerCase()));
      if (present) verifyIds.push(item.id);
      else healIds.push(item.id);
    }

    if (verifyIds.length > 0) {
      await db.supplierSendQueueItem
        .updateMany({
          where: { id: { in: verifyIds } },
          data: {
            sharePointVerifiedAt: now(),
            // Refresh the deep-link target when we re-derived it this run.
            ...(folderWebUrl ? { sharePointFolderUrl: folderWebUrl } : {}),
          },
        })
        .catch(() => {});
      sweep.verified += verifyIds.length;
    }
    if (healIds.length > 0) {
      // Auto re-arm — identical to the manual "retry floated" action, plus
      // clearing the now-stale location so the next sweep re-uploads cleanly.
      await db.supplierSendQueueItem
        .updateMany({
          where: { id: { in: healIds } },
          data: {
            sharePointStatus: "PENDING",
            pushAttempts: 0,
            sharePointUrl: null,
            sharePointFolderUrl: null,
            sharePointVerifiedAt: null,
          },
        })
        .catch(() => {});
      sweep.healed += healIds.length;
      console.warn(
        `[supplier-verify] re-armed ${healIds.length} row(s) for style ${styleId} — file(s) not found in ${parentName}/${APPROVED_LAYOUTS_SUBFOLDER}`,
      );
    }
  }

  return sweep;
}
