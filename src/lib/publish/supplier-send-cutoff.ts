// =====================================================
// The supplier-send PO cutoff — ONE predicate, enforced on every path that can
// put a document in front of a supplier.
//
// The cutoff (getSupplierSendMinPo → supplierSendMinPo, falling back to the
// generation and then the scrape cutoff) means: "orders before this PO are not
// delivered to suppliers". It used to guard exactly one caller —
// reconcileSupplierSendQueue, the historical backfill — while the live paths
// ignored it entirely. On 2026-08-12 a run of bulk regenerations walked ~700
// styles; the runner arms every regenerated style's COVER page into the send
// queue (the cover ships regardless of approval, by design), and at midnight
// the batch emailed all of them: 43 suppliers, 714 outputs, 607 of them for POs
// BELOW the cutoff, oldest PO 61331 — every one of those styles still awaiting
// review. The cutoff was set correctly; nothing on the path read it.
//
// So the rule now lives here, and the four gates below are the complete set:
//
//   ENQUEUE  enqueueApprovedAsset       (publish/supplier-send-queue.ts)
//   ENQUEUE  enqueueCoverForSupplier    (publish/requeue-cover.ts)
//   SEND     runSupplierSendBatch       (publish/supplier-batch-send.ts)
//   PUSH     pushQueuedSupplierUploads  (sharepoint/push-queued-to-supplier.ts)
//
// Both ends are gated on purpose. The enqueue gates keep the queue honest —
// /settings/approved shows what WILL go out, not a pile of rows that will be
// discarded later. The send + push gates are the backstop: they also cover rows
// that predate this change, and the several routes that RE-ARM an existing row
// (retry-floated, choose-po-folder, apply-filename-fix, reconcile-folder,
// monday/retro-link) — those flip push state on rows they don't create, so
// gating creation alone would leave them as a way back in.
//
// There is deliberately no bypass. A targeted reconcile (the per-style delivery
// re-check) used to skip the cutoff; it no longer does, because a row it let in
// would only be dropped at send time — a confusing no-op rather than a feature.
// The escape hatch for a genuinely-needed below-cutoff delivery is unchanged:
// lower the cutoff on /settings/approved, or use the manual per-style push
// buttons, which never went through this lib.
//
// PURE LEAF — no db import, so the predicate can be unit-tested and imported
// from anywhere. Callers load the cutoff themselves via getSupplierSendMinPo().
// =====================================================

// A style is deliverable when the cutoff is unset (no cutoff configured — the
// system-wide default, deliver everything) or its PO sequence is at/above it.
//
// A NULL poSeq is NOT deliverable once a cutoff exists. A style whose PO can't
// be parsed into a number can't be placed on the timeline the cutoff draws, so
// there is no honest way to say it clears the line — the backfill reconciler has
// always taken that stance ("styles with NO parseable PO are also left out") and
// this keeps every path agreeing with it. Verified against the live DB when this
// landed: 0 queue rows and 0 supplier-linked styles with generated assets had a
// null poSeq, so nothing legitimate is caught by it today. Since #291 a style
// cannot generate at all without a PO number, which is what keeps it that way.
export function isDeliverablePo(poSeq: number | null | undefined, cutoff: number | null): boolean {
  if (cutoff === null) return true;
  if (poSeq === null || poSeq === undefined) return false;
  return poSeq >= cutoff;
}

// The same rule as a Prisma `where` fragment, for the queries that filter queue
// rows in bulk (send + push). Spread into an existing where clause.
//
// Note `{ poSeq: { gte: cutoff } }` already excludes NULLs in SQL — a null
// comparison is never true — so this matches isDeliverablePo exactly rather than
// merely resembling it.
export function deliverablePoWhere(cutoff: number | null): { poSeq?: { gte: number } } {
  return cutoff === null ? {} : { poSeq: { gte: cutoff } };
}

// Human-readable reason for logs and the /settings/approved surface.
export function belowCutoffNote(poSeq: number | null | undefined, cutoff: number | null): string {
  if (cutoff === null) return "no supplier-send cutoff set";
  return poSeq === null || poSeq === undefined
    ? `no parseable PO number (supplier-send cutoff is PO ≥ ${cutoff})`
    : `PO ${poSeq} is below the supplier-send cutoff (PO ≥ ${cutoff})`;
}
