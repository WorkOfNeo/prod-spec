import { db } from "@/lib/db";
import { pushApprovedAssetsToSupplier, SupplierPushError } from "./push-to-supplier";
import { parseCustomerConfig } from "@/lib/customers/config";
import { getSupplierBatchSendEnabled } from "@/lib/settings/app-settings";

// =====================================================
// Queue-driven supplier-folder upload (WS2b's missing half). Walks the unsent
// supplier-send queue and pushes each style's approved PDFs into the supplier's
// OWN SharePoint folder (Supplier.sharepointUrl → "<style> – <customer>"
// subfolder, via pushApprovedAssetsToSupplier), then stamps the queue rows'
// sharePointStatus — the previously write-only column /settings/approved shows.
//
// Called fail-soft from every approval path (job publish, per-asset approve,
// runner auto-approve) so files land in the supplier folder the moment an
// output is approved, and again by the midnight cron as a retry sweep so
// everything is in place before the digest email claims "files are in your
// SharePoint folder".
//
// Gated behind the same supplierBatchSendEnabled master flag as the batch
// send — the /settings/approved toggle promises "nothing is pushed and no
// email is sent" while OFF. The manual per-style push buttons bypass this lib
// entirely and keep working regardless.
//
// Status semantics per queue row:
//   UPLOADED — in the supplier folder (sharePointUrl set); not retried.
//   FAILED   — transient/permission error (e.g. write 403); retried next sweep.
//   SKIPPED  — data-shaped gap (no supplier, no folder link, asset no longer
//              approved, customer delivers own). Also retried nightly, so
//              fixing the data (e.g. setting the Monday folder link) self-heals
//              without anyone re-triggering.
// =====================================================

export type SupplierUploadSweep = {
  styles: number;
  uploaded: number;
  failed: number;
  skipped: number;
};

const EMPTY_SWEEP: SupplierUploadSweep = { styles: 0, uploaded: 0, failed: 0, skipped: 0 };

export async function pushQueuedSupplierUploads(opts?: {
  styleIds?: string[];
}): Promise<SupplierUploadSweep> {
  if (!(await getSupplierBatchSendEnabled())) return EMPTY_SWEEP;

  const items = await db.supplierSendQueueItem.findMany({
    where: {
      sentAt: null,
      sharePointStatus: { not: "UPLOADED" },
      ...(opts?.styleIds && opts.styleIds.length > 0 ? { styleId: { in: opts.styleIds } } : {}),
    },
    select: { id: true, styleId: true, jobAssetId: true },
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

  const sweep: SupplierUploadSweep = { styles: byStyle.size, uploaded: 0, failed: 0, skipped: 0 };

  for (const [styleId, styleItems] of byStyle) {
    const stamp = async (ids: string[], status: "FAILED" | "SKIPPED") => {
      if (ids.length === 0) return;
      await db.supplierSendQueueItem
        .updateMany({ where: { id: { in: ids } }, data: { sharePointStatus: status } })
        .catch(() => {});
      sweep[status === "FAILED" ? "failed" : "skipped"] += ids.length;
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

    try {
      const res = await pushApprovedAssetsToSupplier({
        styleId,
        assetIds: withAsset.map((i) => i.jobAssetId as string),
      });
      const byAsset = new Map<string, { uploaded: boolean; url: string | null }>();
      for (const f of res.pushed) byAsset.set(f.assetId, { uploaded: true, url: f.webUrl });
      for (const s of res.skipped) byAsset.set(s.assetId, { uploaded: false, url: null });
      for (const item of withAsset) {
        const hit = byAsset.get(item.jobAssetId as string);
        if (hit?.uploaded) {
          await db.supplierSendQueueItem
            .update({
              where: { id: item.id },
              data: { sharePointStatus: "UPLOADED", sharePointUrl: hit.url },
            })
            .catch(() => {});
          sweep.uploaded += 1;
        } else {
          // Asset no longer approved/print-safe (or gone) — data-shaped skip.
          await stamp([item.id], "SKIPPED");
        }
      }
    } catch (err) {
      // 403 (write not granted yet) and unexpected Graph/network errors are
      // retryable → FAILED. Other SupplierPushErrors (no supplier linked, no
      // folder link on file, nothing pushable) are data gaps → SKIPPED.
      const retryable = !(err instanceof SupplierPushError) || err.httpStatus === 403;
      await stamp(
        withAsset.map((i) => i.id),
        retryable ? "FAILED" : "SKIPPED",
      );
      console.warn(
        `[supplier-upload] push failed for style ${styleId} (${retryable ? "FAILED" : "SKIPPED"}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return sweep;
}
