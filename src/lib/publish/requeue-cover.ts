import { db } from "@/lib/db";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { parseCustomerConfig } from "@/lib/customers/config";
import { isDeliverablePo } from "./supplier-send-cutoff";

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
//     customer (config.skipSupplierDelivery),
//   • the style has ≥1 real output generated. A cover for a style with NO
//     outputs is just the manifest with everything "Waiting for Customer
//     Information"; it must not be auto-shipped to the supplier folder on its
//     own. The cover ships only once there's an actual layout to accompany, and
//   • the style clears the supplier-send PO cutoff.
//
// That last gate is why this function was at the centre of the 2026-08-13 mass
// send. Because the cover is decoupled from approval AND re-armed on EVERY
// generation, it is by far the most reachable way into the supplier queue: a
// run of bulk regens armed a cover for ~700 styles and the midnight digest
// mailed 43 suppliers about orders as old as PO 61331. Decoupling from approval
// is deliberate and stays — the supplier SHOULD learn that work is underway and
// how many outputs to expect. Decoupling from the PO cutoff was never a
// decision; it was simply never wired up. It is now.
// =====================================================

export type CoverRequeueResult = "queued" | "not-delivered" | "no-outputs" | "below-cutoff";

export async function enqueueCoverForSupplier(
  styleId: string,
  coverAssetId: string,
  opts?: {
    // false ⇒ push the file, but keep the row out of tonight's digest. Callers
    // do not choose this freely: it is derived from WHY the cover is being
    // rebuilt (notifiesSupplier in pdf/cover-rebuild-trigger.ts). A wording
    // rebuild passes false — the supplier needs the current manifest in their
    // folder, but an email about an order where nothing they act on changed is
    // noise at best, and at the scale a wording sweep runs it is the 2026-08-13
    // incident in miniature. Defaults true, so the runner and every ordinary
    // re-arm are untouched, and a later real generation flips the row back.
    notifySupplier?: boolean;
  },
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

  // …and the order has to be one we deliver at all. Checked BEFORE the output
  // count below so the cheap answer comes first, and so the cover-regen sweep's
  // per-style outcome says "below-cutoff" rather than the misleading
  // "no-outputs" for an old style that has plenty of them.
  const { getSupplierSendMinPo } = await import("@/lib/settings/app-settings");
  if (!isDeliverablePo(style.poSeq, await getSupplierSendMinPo())) return "below-cutoff";

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
    // Part of the armed state on purpose, not a create-only default: a row
    // silenced by a previous sweep must go back to notifying the moment a real
    // generation re-arms it, or one quiet regen would mute that style's cover
    // for good. The flag therefore belongs to THIS call's trigger and never
    // latches onto the row — pinned by tests/cover-notify-trigger.test.ts.
    notifySupplier: opts?.notifySupplier !== false,
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
