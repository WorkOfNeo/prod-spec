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
  // Partially decided and this user made ≥1 of the decisions.
  mine: ReviewTask[];
  // Partially decided entirely by other users. Visible (muted) so a
  // half-finished review can never hide; not counted in the badge.
  others: ReviewTask[];
  // Documents rendered, nobody has decided anything yet. Global queue —
  // there is no reviewer-assignment concept yet.
  untouched: ReviewTask[];
};

export async function getReviewWork(userId: string): Promise<ReviewWork> {
  const jobs = await db.job.findMany({
    where: { status: "AWAITING_REVIEW" },
    include: {
      style: { include: { customer: true, businessAreaRef: true } },
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
    // Oldest first — the longest-stuck review is the most at risk of being
    // forgotten, so it tops the list.
    orderBy: { createdAt: "asc" },
  });

  const mine: ReviewTask[] = [];
  const others: ReviewTask[] = [];
  const untouched: ReviewTask[] = [];

  for (const job of jobs) {
    if (job.assets.length === 0) continue;
    const decidedAssets = job.assets.filter((a) => a.reviewStatus !== "PENDING_REVIEW");
    const pendingAssets = job.assets.filter((a) => a.reviewStatus === "PENDING_REVIEW");

    const lastDecision = decidedAssets
      .map((a) => a.reviewedAt)
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
      lastActivityAt: lastDecision ?? job.createdAt,
      reviewerEmails: Array.from(
        new Set(decidedAssets.map((a) => a.reviewedBy?.email).filter((e): e is string => !!e)),
      ),
    };

    if (decidedAssets.length === 0) {
      untouched.push(task);
    } else if (decidedAssets.some((a) => a.reviewedById === userId)) {
      mine.push(task);
    } else {
      others.push(task);
    }
  }

  return { mine, others, untouched };
}

// Server-rendered relative times. Coarse on purpose — the page is
// force-dynamic and refreshes on window focus, so minute-precision drift
// is invisible in practice.
export function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks} weeks ago`;
}
