import { db } from "@/lib/db";

// First-writer-wins claim: stamps the responsible reviewer on a job. Used
// by the explicit "Start review" popup AND implicitly by the first
// approve/reject decision, so the two paths can never disagree about who
// owns a review. No-ops (returns false) when someone already claimed it.
export async function claimReviewIfUnclaimed(jobId: string, userId: string): Promise<boolean> {
  const { count } = await db.job.updateMany({
    where: { id: jobId, reviewClaimedById: null },
    data: { reviewClaimedById: userId, reviewClaimedAt: new Date() },
  });
  return count > 0;
}

// Review continuity across re-runs: when a NEW job supersedes a review that
// was already underway, the review's owner must carry over — a regen swaps
// the PDFs underneath a review, it doesn't un-start it. Without this, every
// re-run (bulk "Regenerate all", per-group rerun, auto-sweep top-up) dropped
// the style from /reviews "In Progress" back into the untouched queue.
//
// The carried owner is the prior job's explicit claim when there is one,
// otherwise the human behind its most recent decision (the same "claimed OR
// ≥1 document decided" rule isStarted() buckets by). Auto-approvals
// (reviewedById null) don't count — a machine can't own a review. Returns
// null when no prior started review exists (a genuinely fresh style).
// Shared by the runner's settle path and the one-off backfill script so the
// two can never disagree.
export async function findCarryForwardClaim(
  styleId: string,
  excludeJobId: string,
): Promise<{ userId: string; at: Date } | null> {
  const prior = await db.job.findFirst({
    where: { styleId, id: { not: excludeJobId }, status: "AWAITING_REVIEW" },
    orderBy: { createdAt: "desc" },
    select: {
      reviewClaimedById: true,
      reviewClaimedAt: true,
      assets: {
        where: { reviewStatus: { not: "PENDING_REVIEW" }, reviewedById: { not: null } },
        orderBy: { reviewedAt: "desc" },
        take: 1,
        select: { reviewedById: true, reviewedAt: true },
      },
    },
  });
  if (!prior) return null;
  if (prior.reviewClaimedById) {
    return { userId: prior.reviewClaimedById, at: prior.reviewClaimedAt ?? new Date() };
  }
  const decision = prior.assets[0];
  if (decision?.reviewedById) {
    return { userId: decision.reviewedById, at: decision.reviewedAt ?? new Date() };
  }
  return null;
}
