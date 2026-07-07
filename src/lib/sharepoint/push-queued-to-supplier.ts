import { db } from "@/lib/db";
import { pushApprovedAssetsToSupplier, SupplierPushError } from "./push-to-supplier";
import { parseCustomerConfig } from "@/lib/customers/config";
import { getSupplierBatchSendEnabled } from "@/lib/settings/app-settings";

// =====================================================
// Queue-driven supplier-folder upload (WS2b's missing half). Walks the unsent
// supplier-send queue and pushes each style's approved PDFs into the supplier's
// OWN SharePoint folder (Supplier.sharepointUrl → "<PO> - <customer> -
// <supplier>" folder → "APPROVED LAYOUTS" subfolder, shared across styles on the
// same PO, via pushApprovedAssetsToSupplier), then stamps the queue rows'
// sharePointStatus — the previously write-only column /settings/approved shows.
//
// Called fail-soft from every approval path (job publish, per-asset approve,
// runner auto-approve) so files land in the supplier folder the moment an
// output is approved; by the RECURRING upload sweep (?uploadOnly=1 cron, WS3)
// so retries + backfilled rows drain during the day; and again by the midnight
// cron (includeFloated) so everything is in place before the digest email
// claims "files are in your SharePoint folder".
//
// Gated behind the same supplierBatchSendEnabled master flag as the batch
// send — the /settings/approved toggle promises "nothing is pushed and no
// email is sent" while OFF. The manual per-style push buttons bypass this lib
// entirely and keep working regardless.
//
// Status semantics per queue row:
//   UPLOADED — in the supplier folder (sharePointUrl set); not retried.
//   FAILED   — transient/permission error (e.g. write 403); retried until
//              pushAttempts hits MAX_PUSH_ATTEMPTS, then it "floats" for the
//              recurring sweep (surfaced on /settings/approved). The midnight
//              sweep passes includeFloated and still retries once nightly, so
//              a fixed permission self-heals within a day.
//   SKIPPED  — data-shaped gap (no supplier, no folder link, asset no longer
//              approved, customer delivers own). Also retried each sweep —
//              these fail fast before any Graph write — so fixing the data
//              (e.g. setting the Monday folder link) self-heals without anyone
//              re-triggering.
//
// A queue row is one output SLOT (base variantKey) holding a representative
// jobAssetId. A multi-document slot (carton X-of-Y) has several PDFs — the
// sweep re-expands each slot to ALL of its current approved documents via
// current-outputs, so the whole set lands in the folder, not just the
// representative.
// =====================================================

// Consecutive FAILED pushes before the recurring sweep stops retrying a row
// (mirrors MAX_EAN_ATTEMPTS / MAX_GEN_ATTEMPTS). The midnight sweep ignores
// the cap; a new approved render resets it (see enqueueApprovedAsset).
export const MAX_PUSH_ATTEMPTS = 3;

export type SupplierUploadSweep = {
  styles: number;
  uploaded: number;
  failed: number;
  skipped: number;
  noFolder: number; // PO folder not found under the supplier (flagged, retried each sweep)
  ambiguous: number; // several folders match the PO — needs a human (flagged, retried)
};

const EMPTY_SWEEP: SupplierUploadSweep = {
  styles: 0,
  uploaded: 0,
  failed: 0,
  skipped: 0,
  noFolder: 0,
  ambiguous: 0,
};

// Non-UPLOADED terminal statuses the sweep stamps. NO_FOLDER / AMBIGUOUS are new
// folder-shaped flags (PO folder absent / several match); all three non-FAILED
// take no strike so they retry every sweep until the gap is fixed.
type StampStatus = "FAILED" | "SKIPPED" | "NO_FOLDER" | "AMBIGUOUS";

export async function pushQueuedSupplierUploads(opts?: {
  styleIds?: string[];
  // Midnight retry sweep: also retry rows that already used up their
  // MAX_PUSH_ATTEMPTS strikes. The recurring day-time sweep leaves them
  // floated so a persistent 403 can't hammer Graph every tick.
  includeFloated?: boolean;
}): Promise<SupplierUploadSweep> {
  if (!(await getSupplierBatchSendEnabled())) return EMPTY_SWEEP;

  const items = await db.supplierSendQueueItem.findMany({
    where: {
      sentAt: null,
      sharePointStatus: { not: "UPLOADED" },
      ...(opts?.styleIds && opts.styleIds.length > 0 ? { styleId: { in: opts.styleIds } } : {}),
      ...(opts?.includeFloated
        ? {}
        : { NOT: { sharePointStatus: "FAILED", pushAttempts: { gte: MAX_PUSH_ATTEMPTS } } }),
    },
    select: { id: true, styleId: true, variantKey: true, jobAssetId: true },
    orderBy: { queuedAt: "asc" },
  });
  if (items.length === 0) return EMPTY_SWEEP;

  const byStyle = new Map<string, typeof items>();
  for (const it of items) {
    const arr = byStyle.get(it.styleId) ?? [];
    arr.push(it);
    byStyle.set(it.styleId, arr);
  }

  // Customers who deliver their own goods (skipSupplierDelivery) must never
  // have files land in a supplier folder — mirror the delivery gate in
  // publishApprovedJob.
  const styleRows = await db.style.findMany({
    where: { id: { in: [...byStyle.keys()] } },
    select: { id: true, customer: { select: { config: true } } },
  });
  const skipDeliveryByStyle = new Map(
    styleRows.map((s) => [s.id, parseCustomerConfig(s.customer.config).skipSupplierDelivery]),
  );

  const sweep: SupplierUploadSweep = {
    styles: byStyle.size,
    uploaded: 0,
    failed: 0,
    skipped: 0,
    noFolder: 0,
    ambiguous: 0,
  };
  const now = () => new Date();

  // FAILED counts a strike (pushAttempts++); every other flagged status is a
  // data/folder gap that failed fast — stamped without a strike so it keeps
  // self-healing (retried each sweep until the underlying gap is closed).
  const counterOf: Record<StampStatus, keyof SupplierUploadSweep> = {
    FAILED: "failed",
    SKIPPED: "skipped",
    NO_FOLDER: "noFolder",
    AMBIGUOUS: "ambiguous",
  };

  for (const [styleId, styleItems] of byStyle) {
    const stamp = async (ids: string[], status: StampStatus) => {
      if (ids.length === 0) return;
      await db.supplierSendQueueItem
        .updateMany({
          where: { id: { in: ids } },
          data: {
            sharePointStatus: status,
            lastPushAt: now(),
            ...(status === "FAILED" ? { pushAttempts: { increment: 1 } } : {}),
          },
        })
        .catch(() => {});
      sweep[counterOf[status]] += ids.length;
    };

    if (skipDeliveryByStyle.get(styleId)) {
      await stamp(
        styleItems.map((i) => i.id),
        "SKIPPED",
      );
      continue;
    }

    // Rows without a surviving asset reference can't produce a PDF — settle
    // them as SKIPPED instead of leaving them forever-pending.
    const withAsset = styleItems.filter((i) => i.jobAssetId != null);
    await stamp(
      styleItems.filter((i) => i.jobAssetId == null).map((i) => i.id),
      "SKIPPED",
    );
    if (withAsset.length === 0) continue;

    // Expand each slot to ALL of its current approved + print-safe documents
    // (a carton X-of-Y is several PDFs behind one queue row). Falls back to
    // the stored representative when current-outputs can't resolve the slot —
    // the old behaviour, still correct for single-document outputs.
    const docIdsByItem = new Map<string, string[]>();
    try {
      const { getCurrentOutputsForStyle } = await import("@/lib/outputs/current-outputs");
      const outputs = await getCurrentOutputsForStyle(styleId);
      const approvedByBase = new Map<string, string[]>();
      for (const o of outputs) {
        if (o.jobAssetId == null) continue;
        if (o.reviewStatus !== "APPROVED" || o.placeholderCount > 0) continue;
        const b = o.variantKey.split("#")[0] || `doc:${o.docType}`;
        const arr = approvedByBase.get(b) ?? [];
        arr.push(o.jobAssetId);
        approvedByBase.set(b, arr);
      }
      for (const item of withAsset) {
        const docs = approvedByBase.get(item.variantKey);
        docIdsByItem.set(item.id, docs && docs.length > 0 ? docs : [item.jobAssetId as string]);
      }
    } catch {
      for (const item of withAsset) docIdsByItem.set(item.id, [item.jobAssetId as string]);
    }

    const allAssetIds = [...new Set([...docIdsByItem.values()].flat())];

    try {
      const res = await pushApprovedAssetsToSupplier({ styleId, assetIds: allAssetIds });
      const uploadedByAsset = new Map<string, string | null>();
      for (const f of res.pushed) uploadedByAsset.set(f.assetId, f.webUrl);
      for (const item of withAsset) {
        const docIds = docIdsByItem.get(item.id) ?? [];
        // The slot is UPLOADED only when EVERY one of its documents landed.
        if (docIds.length > 0 && docIds.every((id) => uploadedByAsset.has(id))) {
          await db.supplierSendQueueItem
            .update({
              where: { id: item.id },
              data: {
                sharePointStatus: "UPLOADED",
                sharePointUrl: uploadedByAsset.get(docIds[0]) ?? res.targetFolderUrl,
                // The APPROVED LAYOUTS subfolder — deep-linked from
                // /settings/approved and re-checked by the self-heal verify.
                sharePointFolderUrl: res.targetFolderUrl,
                // A fresh push IS a verification: we just wrote the file. Stamp
                // it so the verify pass doesn't immediately re-check it.
                sharePointVerifiedAt: now(),
                lastPushAt: now(),
              },
            })
            .catch(() => {});
          sweep.uploaded += 1;
        } else {
          // Asset no longer approved/print-safe (or gone) — data-shaped skip.
          await stamp([item.id], "SKIPPED");
        }
      }
    } catch (err) {
      // Folder-shaped refusals get their own flag so /style + /settings/approved
      // can say WHY (PO folder missing / ambiguous) and the row keeps re-checking
      // each sweep. 403 (write not granted) + unexpected Graph/network errors are
      // retryable → FAILED. Other SupplierPushErrors (no supplier linked, no
      // folder link on file, nothing pushable) are data gaps → SKIPPED.
      let status: StampStatus;
      if (err instanceof SupplierPushError && err.kind === "no-folder") status = "NO_FOLDER";
      else if (err instanceof SupplierPushError && err.kind === "ambiguous-folder") status = "AMBIGUOUS";
      else status = !(err instanceof SupplierPushError) || err.httpStatus === 403 ? "FAILED" : "SKIPPED";
      await stamp(
        withAsset.map((i) => i.id),
        status,
      );
      console.warn(
        `[supplier-upload] push not completed for style ${styleId} (${status}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return sweep;
}
