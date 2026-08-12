import { db } from "@/lib/db";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { parseCustomerConfig } from "@/lib/customers/config";

// =====================================================
// Queue (or re-arm) a style's COVER row in the supplier-send queue. The cover is
// a framing MANIFEST, not a reviewable layout, so its delivery is deliberately
// decoupled from approval: it ALWAYS ships to the supplier folder as soon as it
// exists and is re-armed on every regeneration, so the folder always holds the
// current cover. This is called from
//   • the runner, on every generation (arm the freshly-rendered cover), and
//   • the "Regenerate cover pages" sweep, after refreshing a cover in place.
//
// The force-arm is required either way: enqueueApprovedAsset's "isNewRender"
// check keys off jobAssetId, so an in-place refresh (same id) would look
// unchanged and never re-send; and a fresh render must reset the SharePoint
// push state. Once armed, the recurring SharePoint sweep / pushQueuedSupplierUploads
// re-pushes it (overwriting the prior cover by its stable filename) and the
// nightly digest carries it.
//
// Gates (approval is NOT one):
//   • a real delivery target — a linked supplier that isn't a self-delivering
//     customer (config.skipSupplierDelivery), and
//   • the style has ≥1 real output generated. A cover for a style with NO
//     outputs is just the manifest with everything "Waiting for Customer
//     Information"; it must not be auto-shipped to the supplier folder on its
//     own. The cover ships only once there's an actual layout to accompany.
// =====================================================

export type CoverRequeueResult = "queued" | "not-delivered" | "no-outputs";

export async function enqueueCoverForSupplier(
  styleId: string,
  coverAssetId: string,
): Promise<CoverRequeueResult> {
  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      customerId: true,
      supplierId: true,
      poSeq: true,
      customer: { select: { config: true } },
    },
  });
  if (!style) return "not-delivered";

  // The cover ships regardless of approval, but it still needs a real delivery
  // target. No supplier → nothing to push to. skipSupplierDelivery customers
  // deliver their own goods; their styles never enter the queue.
  if (!style.supplierId) return "not-delivered";
  if (parseCustomerConfig(style.customer.config).skipSupplierDelivery) return "not-delivered";

  // Don't auto-ship a cover for a style that has no real outputs yet — a
  // cover-only bundle (the manifest with everything "Waiting for Customer
  // Information") must never land in the supplier folder on its own. Require
  // ≥1 generated output document (any review status; framing pages — cover /
  // general info — and legacy null-key rows don't count). Same "has a generated
  // output" shape the /styles bulk-regen route uses.
  const outputCount = await db.jobAsset.count({
    where: {
      job: { styleId, status: { not: "FAILED" } },
      variantKey: { notIn: [COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY], not: null },
    },
  });
  if (outputCount === 0) return "no-outputs";

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
