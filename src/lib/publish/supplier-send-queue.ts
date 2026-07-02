import { db } from "@/lib/db";
import { loadIgnoredOutputKeys } from "@/lib/outputs/output-ignores";
import { parseCustomerConfig } from "@/lib/customers/config";

// Nightly supplier-send queue (WS2). One row per approved (style, output slot).
//
// This module is pure CAPTURE — it records that an approved output is waiting
// to reach its supplier. It NEVER pushes to SharePoint or sends email; that is
// the midnight cron's job (WS2b) and is gated behind supplierBatchSendEnabled.
// So enqueueing is ALWAYS safe to run, even while sending is off — the queue is
// what /settings/approved reads to show "what would be sent tonight".
//
// Keyed by the BASE variantKey (a multi-document output like a carton X-of-Y
// collapses to one slot), matching the per-output granularity the review page
// uses. The stored jobAssetId is a representative of the current approved
// render; the sender re-resolves the actual approved PDFs at send time.

// Shape we need off an approved asset — accepts the JobAsset row (or the subset
// the approve routes already have loaded).
export type ApprovableAsset = {
  id: string;
  styleId: string;
  variantKey: string | null;
  docType: string;
  displayName?: string | null;
};

function baseKey(variantKey: string | null, docType: string): string {
  const v = (variantKey ?? "").split("#")[0];
  return v || `doc:${docType}`;
}

// Upsert the queue row for one approved output. Idempotent: re-approving the
// SAME render is a no-op on the send lifecycle; approving a NEW render of an
// already-sent slot (jobAssetId changed) re-arms it (clears sentAt / push
// state) so the corrected version goes out again. Fail-soft — a queue hiccup
// must never break the approval itself; callers wrap in try/catch too.
export async function enqueueApprovedAsset(asset: ApprovableAsset): Promise<void> {
  const style = await db.style.findUnique({
    where: { id: asset.styleId },
    select: {
      customerId: true,
      supplierId: true,
      poSeq: true,
      customer: { select: { config: true } },
    },
  });
  if (!style) return;

  // Customers who deliver their own goods (config.skipSupplierDelivery) get no
  // supplier delivery at all — keep their approvals out of the nightly queue
  // (and thereby out of the digest email and the supplier-folder push).
  if (parseCustomerConfig(style.customer.config).skipSupplierDelivery) return;

  const variantKey = baseKey(asset.variantKey, asset.docType);

  // Choke point for the per-style operator ignore: an ignored output must
  // never (re)enter the nightly queue, whichever approval path enqueued it
  // (per-asset approve, job publish cascade, runner auto-approve).
  const ignoredKeys = await loadIgnoredOutputKeys(asset.styleId);
  if (ignoredKeys.has(variantKey)) return;
  const existing = await db.supplierSendQueueItem.findUnique({
    where: { styleId_variantKey: { styleId: asset.styleId, variantKey } },
    select: { jobAssetId: true },
  });
  const isNewRender = existing != null && existing.jobAssetId !== asset.id;

  await db.supplierSendQueueItem.upsert({
    where: { styleId_variantKey: { styleId: asset.styleId, variantKey } },
    create: {
      styleId: asset.styleId,
      variantKey,
      jobAssetId: asset.id,
      docType: asset.docType,
      displayName: asset.displayName ?? null,
      customerId: style.customerId,
      supplierId: style.supplierId,
      poSeq: style.poSeq,
    },
    update: {
      jobAssetId: asset.id,
      docType: asset.docType,
      displayName: asset.displayName ?? null,
      customerId: style.customerId,
      supplierId: style.supplierId,
      poSeq: style.poSeq,
      // A new render of an already-shipped slot must be re-sent.
      ...(isNewRender
        ? {
            sentAt: null,
            sharePointStatus: "PENDING",
            sharePointUrl: null,
            emailLogId: null,
            batchId: null,
            queuedAt: new Date(),
          }
        : {}),
    },
  });
}

// Convenience: enqueue every APPROVED, placeholder-free asset of a job. Used by
// the runner's auto-approve path and the job-level "Approve all" cascade. Never
// throws — logs-and-continues so one bad row can't block a publish.
export async function enqueueApprovedAssetsForJob(jobId: string): Promise<void> {
  const assets = await db.jobAsset.findMany({
    where: { jobId, reviewStatus: "APPROVED", placeholderCount: 0 },
    select: { id: true, variantKey: true, docType: true, displayName: true, job: { select: { styleId: true } } },
  });
  for (const a of assets) {
    try {
      await enqueueApprovedAsset({
        id: a.id,
        styleId: a.job.styleId,
        variantKey: a.variantKey,
        docType: a.docType,
        displayName: a.displayName,
      });
    } catch (err) {
      console.warn(`[supplier-send-queue] enqueue failed for asset ${a.id}:`, err);
    }
  }
}
