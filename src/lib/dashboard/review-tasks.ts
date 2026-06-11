import { db } from "@/lib/db";

// Derived review work — powers /dashboard and the sidebar badge. Nothing
// here is event-sourced: an unfinished review is a fact already sitting in
// Job/JobAsset (job AWAITING_REVIEW + per-asset decisions), so the lists
// are correct even when the exit was a killed tab, and they auto-clear the
// moment a job settles (it simply leaves AWAITING_REVIEW). No cleanup, no
// "mark as done", no stale reminders.

export type ReviewTask = {
  jobId: string;
  styleId: string;
  styleName: string;
  customerName: string;
  businessArea: string | null;
  poNumber: string | null;
  total: number;
  decided: number;
  // Every remaining pending document carries placeholder artifacts —
  // approval is ship-gated, so the review can't be finished until the data
  // is fixed and the output re-run from the style page.
  blocked: boolean;
  // All documents decided but the job is still AWAITING_REVIEW — the
  // post-approval publish (SharePoint + supplier email) failed and the
  // review screen's "Approve all & publish" is the retry.
  needsPublishRetry: boolean;
  // Newest decision for partial reviews; job creation for untouched ones.
  lastActivityAt: Date;
  // Who decided so far — labels the "in review by others" rows.
  reviewerEmails: string[];
};

export type ReviewWork = {
  // This user's responsibility: they claimed the review ("Start review")
  // and/or made ≥1 of the decisions, with documents still pending.
  mine: ReviewTask[];
  // Claimed/decided by other users only. Visible (muted) so a
  // half-finished review can never hide; not counted in the badge.
  others: ReviewTask[];
  // Documents rendered, unclaimed, nothing decided. Global queue — there
  // is no reviewer-assignment concept yet.
  untouched: ReviewTask[];
};

export async function getReviewWork(userId: string): Promise<ReviewWork> {
  const jobs = await db.job.findMany({
    where: { status: "AWAITING_REVIEW" },
    include: {
      style: { include: { customer: true, businessAreaRef: true } },
      reviewClaimedBy: { select: { email: true } },
      assets: {
        select: {
          reviewStatus: true,
          reviewedById: true,
          reviewedAt: true,
          placeholderCount: true,
          reviewedBy: { select: { email: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // One task per STYLE: the review screen always shows the NEWEST awaiting
  // job (take 1, newest first), so that is the only actionable unit — a
  // style re-run can leave older jobs stranded in AWAITING_REVIEW, and
  // listing those would produce duplicate rows whose CTA opens a different
  // job than the row described. Newest job per style wins; superseded jobs
  // (and any partial decisions on them) are deliberately invisible here.
  const latestPerStyle = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    if (!latestPerStyle.has(job.styleId)) latestPerStyle.set(job.styleId, job);
  }

  const mine: ReviewTask[] = [];
  const others: ReviewTask[] = [];
  const untouched: ReviewTask[] = [];

  for (const job of latestPerStyle.values()) {
    if (job.assets.length === 0) continue;
    const decidedAssets = job.assets.filter((a) => a.reviewStatus !== "PENDING_REVIEW");
    const pendingAssets = job.assets.filter((a) => a.reviewStatus === "PENDING_REVIEW");

    // Activity = the newest of: a decision, or the claim itself ("Start
    // review" with no clicks yet is still activity worth surfacing).
    const lastActivity = [
      ...decidedAssets.map((a) => a.reviewedAt),
      job.reviewClaimedAt,
    ]
      .filter((d): d is Date => d != null)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    const task: ReviewTask = {
      jobId: job.id,
      styleId: job.styleId,
      styleName: job.style.name,
      customerName: job.style.customer.name,
      businessArea: job.style.businessAreaRef?.name ?? job.style.businessArea ?? null,
      poNumber: job.style.poNumber ?? null,
      total: job.assets.length,
      decided: decidedAssets.length,
      blocked: pendingAssets.length > 0 && pendingAssets.every((a) => a.placeholderCount > 0),
      needsPublishRetry: pendingAssets.length === 0,
      lastActivityAt: lastActivity ?? job.createdAt,
      reviewerEmails: Array.from(
        new Set(
          [...decidedAssets.map((a) => a.reviewedBy?.email), job.reviewClaimedBy?.email].filter(
            (e): e is string => !!e,
          ),
        ),
      ),
    };

    const touched = decidedAssets.length > 0 || job.reviewClaimedById != null;
    if (!touched) {
      untouched.push(task);
    } else if (
      job.reviewClaimedById === userId ||
      decidedAssets.some((a) => a.reviewedById === userId)
    ) {
      mine.push(task);
    } else {
      others.push(task);
    }
  }

  // Oldest first — the longest-stuck review is the most at risk of being
  // forgotten, so it tops each list.
  const byAge = (a: ReviewTask, b: ReviewTask) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime();
  mine.sort(byAge);
  others.sort(byAge);
  untouched.sort(byAge);

  return { mine, others, untouched };
}

// Relative-time formatting moved to lib/time so client components (the
// review claim chip) can share it without pulling in the db import above.
export { timeAgo } from "@/lib/time";
