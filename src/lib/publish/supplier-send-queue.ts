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
      // A new render of an already-shipped slot must be re-sent. Push attempts
      // reset too — the fresh PDF gets its full 3 strikes (WS3 float).
      ...(isNewRender
        ? {
            sentAt: null,
            sharePointStatus: "PENDING",
            sharePointUrl: null,
            pushAttempts: 0,
            lastPushAt: null,
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

export type ReconcileSummary = {
  cutoff: number | null;
  scanned: number; // candidate styles examined this tick
  stylesEnqueued: number; // styles that got ≥1 new queue row
  outputsEnqueued: number; // queue rows created
};

// =====================================================
// Backfill reconciler (WS3). Approve-time capture only started with the queue
// (PR #172/#180) — styles approved BEFORE that have approved outputs but no
// queue rows, so they never reach the supplier folder or the nightly digest.
// This sweep finds them and runs each approved output slot through the same
// enqueueApprovedAsset gate the live paths use (ignores, skip-delivery and
// re-arm semantics can't drift).
//
// Scope guards, in order:
//   • Cutoff (Option A): only styles with poSeq >= getSupplierSendMinPo().
//     Unset cutoff (whole fallback chain) ⇒ reconcile does NOTHING — the
//     backfill is opt-in via an explicit cutoff, so it can never blast
//     suppliers with the full historical archive. Styles with NO parseable PO
//     (poSeq NULL) are also left out — they can't be placed on the timeline;
//     approve-time capture still covers them going forward.
//   • Only styles with ZERO queue rows. A style with any row is "captured" —
//     the approve paths keep it fresh (new render ⇒ re-arm). This keeps the
//     sweep from re-walking the whole book every tick; the rare style whose
//     later approval hit the fail-soft catch can still be pushed manually.
//   • Bounded per tick — the backlog drains over several sweeps instead of
//     enqueueing hundreds of uploads at once (mirrors the generation sweep).
//
// Slot rule: an output slot (base variantKey) backfills only when EVERY one of
// its current documents is APPROVED and print-safe — same as the durable-
// approval set (approvedBaseVariantKeys). The newest current document is the
// representative on the queue row; the push sweep re-expands to all documents.
// =====================================================
export async function reconcileSupplierSendQueue(limit = 25): Promise<ReconcileSummary> {
  const { getSupplierSendMinPo } = await import("@/lib/settings/app-settings");
  const { getCurrentOutputsForStyle } = await import("@/lib/outputs/current-outputs");

  const summary: ReconcileSummary = { cutoff: null, scanned: 0, stylesEnqueued: 0, outputsEnqueued: 0 };
  const cutoff = await getSupplierSendMinPo();
  summary.cutoff = cutoff;
  if (cutoff === null) return summary;

  // Styles already captured (any queue row, sent or not) are the approve
  // paths' responsibility — exclude them so candidates shrink as we go.
  const queued = await db.supplierSendQueueItem.findMany({
    select: { styleId: true },
    distinct: ["styleId"],
  });
  const queuedStyleIds = queued.map((q) => q.styleId);

  // Over-fetch: some candidates' approvals turn out superseded/orphaned once
  // current-outputs resolves (nothing to enqueue) — scan past them so they
  // can't wedge the window shut, but never process more than `limit` styles.
  const candidates = await db.style.findMany({
    where: {
      poSeq: { gte: cutoff },
      ...(queuedStyleIds.length > 0 ? { id: { notIn: queuedStyleIds } } : {}),
      jobs: {
        some: {
          status: { not: "FAILED" },
          assets: { some: { reviewStatus: "APPROVED", placeholderCount: 0 } },
        },
      },
    },
    select: { id: true },
    orderBy: { poSeq: "desc" },
    take: Math.max(limit, 1) * 4,
  });

  for (const { id: styleId } of candidates) {
    if (summary.stylesEnqueued >= limit) break;
    summary.scanned += 1;

    let outputs;
    try {
      outputs = await getCurrentOutputsForStyle(styleId);
    } catch (err) {
      console.warn(`[supplier-send-queue] reconcile: current-outputs failed for ${styleId}:`, err);
      continue;
    }

    // Group current documents by slot (base variantKey); a slot qualifies when
    // every document is APPROVED + print-safe. EXCLUDED/ignored slots have no
    // approved documents, so they drop out here (and enqueueApprovedAsset
    // re-checks ignores anyway).
    const byBase = new Map<string, typeof outputs>();
    for (const o of outputs) {
      if (o.jobAssetId == null) continue; // never generated → nothing to send
      const b = baseKey(o.variantKey, o.docType);
      const arr = byBase.get(b);
      if (arr) arr.push(o);
      else byBase.set(b, [o]);
    }

    let enqueuedHere = 0;
    for (const docs of byBase.values()) {
      const allApproved = docs.every(
        (d) => d.reviewStatus === "APPROVED" && d.placeholderCount === 0 && d.state === "APPROVED",
      );
      if (!allApproved) continue;
      const rep = docs[0];
      try {
        await enqueueApprovedAsset({
          id: rep.jobAssetId as string,
          styleId,
          variantKey: rep.variantKey,
          docType: rep.docType,
          displayName: rep.name,
        });
        enqueuedHere += 1;
      } catch (err) {
        console.warn(`[supplier-send-queue] reconcile enqueue failed for ${styleId}/${rep.variantKey}:`, err);
      }
    }

    if (enqueuedHere > 0) {
      summary.stylesEnqueued += 1;
      summary.outputsEnqueued += enqueuedHere;
    }
  }

  return summary;
}
