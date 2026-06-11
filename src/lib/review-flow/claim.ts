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
