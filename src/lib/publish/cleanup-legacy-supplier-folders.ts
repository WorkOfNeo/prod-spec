import { db } from "@/lib/db";
import {
  resolveSupplierFolder,
  findChildFolder,
  deleteDriveItem,
  SharePointWriteForbiddenError,
} from "@/lib/sharepoint/supplier-folder";
import {
  supplierParentFolderName,
  legacyStyleCustomerFolderName,
  flatApprovedLayoutsFolderName,
  APPROVED_LAYOUTS_SUBFOLDER,
} from "@/lib/sharepoint/supplier-folder-names";

// =====================================================
// Delete the WRONG supplier folders left behind by the two earlier naming
// schemes, now that the live layout is "<PO> - <customer> - <supplier>/APPROVED
// LAYOUTS/". Two shapes get cleaned up (see supplier-folder-names.ts):
//   • "<style> – <customer>"                              (pre-rename push)
//   • "<PO> - <customer> - <supplier> - APPROVED LAYOUTS" (first rename, flat)
//
// SAFETY — the flat folder currently HOLDS the pushed PDFs, so we must not delete
// anything until the correct structure exists AND has files. Per style we verify
// the "<PO> - <customer> - <supplier>" parent has an "APPROVED LAYOUTS" subfolder
// with childCount > 0; only then is deletion allowed for that style. So the safe
// order is: run the corrected backfill (--apply) FIRST, then this. Run before the
// backfill and everything reports SKIPPED — nothing is deleted.
//
// We only ever delete folders whose names we RECONSTRUCT from our own data (the
// two wrong shapes above) — never an arbitrary enumeration — and never the
// correct parent. Dry-run by default. Idempotent (a re-run finds the folders
// already gone). Scope mirrors the backfill: styles that were actually pushed
// (Style.supplierFolderUrl set).
// =====================================================

export type LegacyFolderKind = "legacy-style-customer" | "flat-approved-layouts";
export type FolderCleanupOutcome = "DELETED" | "WOULD_DELETE" | "SKIPPED" | "FAILED";

export type FolderCleanupItem = {
  styleId: string;
  styleName: string;
  supplierName: string | null;
  kind: LegacyFolderKind;
  folderName: string;
  webUrl: string | null;
  outcome: FolderCleanupOutcome;
  note?: string;
};

export type LegacyCleanupResult = {
  dryRun: boolean;
  stylesScanned: number;
  found: number; // wrong folders located
  deleted: number;
  wouldDelete: number;
  skipped: number; // located, but the correct folder isn't ready → not safe to delete
  failed: number;
  writeForbidden: boolean; // a 403 was hit (FLC write not granted)
  items: FolderCleanupItem[]; // located folders only (the many not-founds are omitted)
};

export async function cleanupLegacySupplierFolders(opts?: {
  dryRun?: boolean;
  styleIds?: string[];
}): Promise<LegacyCleanupResult> {
  const dryRun = opts?.dryRun ?? false;

  const styles = await db.style.findMany({
    where: {
      supplierFolderUrl: { not: null },
      ...(opts?.styleIds && opts.styleIds.length > 0 ? { id: { in: opts.styleIds } } : {}),
    },
    select: {
      id: true,
      name: true,
      poNumber: true,
      supplier: { select: { name: true, sharepointUrl: true } },
      customer: { select: { name: true } },
    },
    orderBy: { name: "asc" },
  });

  const items: FolderCleanupItem[] = [];
  let found = 0;
  let deleted = 0;
  let wouldDelete = 0;
  let skipped = 0;
  let failed = 0;
  let writeForbidden = false;

  // A flat "… - APPROVED LAYOUTS" folder is shared by every style under one PO —
  // process each resolved drive item at most once.
  const processed = new Set<string>();

  for (const style of styles) {
    const supplier = style.supplier;
    const sharingUrl = supplier?.sharepointUrl?.trim();
    if (!supplier || !sharingUrl) continue; // no supplier folder to clean

    let root;
    try {
      root = await resolveSupplierFolder(sharingUrl);
    } catch {
      continue; // can't open the supplier root — nothing we can safely do
    }

    const nameInput = {
      poNumber: style.poNumber,
      styleName: style.name,
      customerName: style.customer.name,
      supplierName: supplier.name,
    };
    const correctParent = supplierParentFolderName(nameInput);

    // Safety gate: only delete once the CORRECT structure exists AND holds files
    // — parent "<PO> - <customer> - <supplier>" with an "APPROVED LAYOUTS"
    // subfolder whose childCount > 0. Until then a wrong folder may be the only
    // copy of the PDFs, so we skip.
    let safeToDelete = false;
    try {
      const parent = await findChildFolder(root.driveId, root.itemId, correctParent);
      if (parent) {
        const leaf = await findChildFolder(root.driveId, parent.id, APPROVED_LAYOUTS_SUBFOLDER);
        safeToDelete = leaf != null && leaf.childCount > 0;
      }
    } catch (err) {
      if (err instanceof SharePointWriteForbiddenError) writeForbidden = true;
      safeToDelete = false;
    }

    const candidates: Array<{ kind: LegacyFolderKind; name: string }> = [
      { kind: "legacy-style-customer", name: legacyStyleCustomerFolderName(style.name, style.customer.name) },
      { kind: "flat-approved-layouts", name: flatApprovedLayoutsFolderName(nameInput) },
    ];

    for (const cand of candidates) {
      // Never touch the correct parent (names differ by construction, but guard).
      if (cand.name === correctParent) continue;

      let hit;
      try {
        hit = await findChildFolder(root.driveId, root.itemId, cand.name);
      } catch (err) {
        if (err instanceof SharePointWriteForbiddenError) writeForbidden = true;
        continue;
      }
      if (!hit) continue; // not present — nothing to delete

      const dedupKey = `${root.driveId}:${hit.id}`;
      if (processed.has(dedupKey)) continue; // shared flat folder already handled
      processed.add(dedupKey);

      found += 1;
      const item: FolderCleanupItem = {
        styleId: style.id,
        styleName: style.name,
        supplierName: supplier.name,
        kind: cand.kind,
        folderName: cand.name,
        webUrl: hit.webUrl,
        outcome: "WOULD_DELETE",
      };

      if (!safeToDelete) {
        item.outcome = "SKIPPED";
        item.note = "correct APPROVED LAYOUTS folder not found / empty — run the corrected backfill --apply first";
        skipped += 1;
        items.push(item);
        continue;
      }

      if (dryRun) {
        wouldDelete += 1;
        items.push(item);
        continue;
      }

      try {
        const res = await deleteDriveItem(root.driveId, hit.id);
        item.outcome = "DELETED";
        if (res.alreadyGone) item.note = "already gone";
        deleted += 1;
      } catch (err) {
        if (err instanceof SharePointWriteForbiddenError) writeForbidden = true;
        item.outcome = "FAILED";
        item.note = (err as Error).message;
        failed += 1;
      }
      items.push(item);
    }
  }

  return {
    dryRun,
    stylesScanned: styles.length,
    found,
    deleted,
    wouldDelete,
    skipped,
    failed,
    writeForbidden,
    items,
  };
}
