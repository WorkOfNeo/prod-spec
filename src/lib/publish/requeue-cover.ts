import { db } from "@/lib/db";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { parseCustomerConfig } from "@/lib/customers/config";

// =====================================================
// Re-arm a style's COVER row in the supplier-send queue after its cover PDF was
// refreshed in place (see refreshStyleCoverAsset). The bytes changed but the
// JobAsset id did NOT, so enqueueApprovedAsset's "isNewRender" check (which
// keys off jobAssetId) would treat it as unchanged and never re-send. This
// forces the re-arm so the existing delivery path carries the updated cover:
//   • the recurring SharePoint sweep (and pushQueuedSupplierUploads) re-pushes
//     it to the supplier's "APPROVED LAYOUTS" folder, and
//   • the nightly digest re-emails the supplier ("updated file").
//
// Only for styles actually delivered to a supplier: APPROVED, a linked
// supplier, and not a self-delivering customer (config.skipSupplierDelivery).
// Everything else refreshes the cover in place only — it ships with the current
// format when it's approved normally.
// =====================================================

export type CoverRequeueResult = "queued" | "not-delivered";

export async function requeueCoverForSupplier(
  styleId: string,
  coverAssetId: string,
): Promise<CoverRequeueResult> {
  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      status: true,
      customerId: true,
      supplierId: true,
      poSeq: true,
      customer: { select: { config: true } },
    },
  });
  if (!style) return "not-delivered";

  // Not delivered to a supplier → nothing to re-arm. skipSupplierDelivery
  // customers deliver their own goods; their approvals never enter the queue.
  if (style.status !== "APPROVED" || !style.supplierId) return "not-delivered";
  if (parseCustomerConfig(style.customer.config).skipSupplierDelivery) return "not-delivered";

  // Force-armed state: whether the row existed (previously sent) or not, it
  // must end up pending + unpushed so the sweep + digest pick the fresh cover.
  const armed = {
    jobAssetId: coverAssetId,
    sentAt: null,
    sharePointStatus: "PENDING",
    sharePointUrl: null,
    sharePointFolderMatches: null,
    pushAttempts: 0,
    lastPushAt: null,
    emailLogId: null,
    batchId: null,
    queuedAt: new Date(),
  };

  await db.supplierSendQueueItem.upsert({
    where: { styleId_variantKey: { styleId, variantKey: COVER_VARIANT_KEY } },
    create: {
      styleId,
      variantKey: COVER_VARIANT_KEY,
      docType: "COVER",
      displayName: "Cover page",
      customerId: style.customerId,
      supplierId: style.supplierId,
      poSeq: style.poSeq,
      ...armed,
    },
    update: {
      docType: "COVER",
      displayName: "Cover page",
      customerId: style.customerId,
      supplierId: style.supplierId,
      poSeq: style.poSeq,
      ...armed,
    },
  });

  return "queued";
}
