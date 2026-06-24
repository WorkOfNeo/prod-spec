import { db } from "@/lib/db";
import {
  getCurrentOutputsForStyle,
  rollupOutputSlots,
  type CurrentOutput,
  type OutputState,
} from "@/lib/outputs/current-outputs";

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
  // Review progress over outputs that already have a document (CROSS-JOB — the
  // same model the review PAGE uses): `decided` of `total` reviewable. Outputs
  // still being generated aren't counted here; they live in `stillComing`.
  total: number;
  decided: number;
  // Declared outputs with no reviewable document yet — awaiting data, queued,
  // or mid-render. > 0 ⇒ this batch is INCOMPLETE: more documents are on their
  // way, so a reviewer who sees only 1 of 3 knows the rest are still coming.
  stillComing: number;
  // Generation coverage, SLOT-based (a multi-document output counts once) —
  // the same metric the review page header shows: generatedSlots of totalSlots
  // produced. Lets the queue card say "3/5 generated" at a glance.
  generatedSlots: number;
  totalSlots: number;
  // Every remaining pending document carries placeholder artifacts —
  // approval is ship-gated, so the review can't be finished until the data
  // is fixed and the output re-run from the style page.
  blocked: boolean;
  // All of the newest job's documents decided but it's still AWAITING_REVIEW —
  // the post-approval publish (SharePoint + supplier email) failed and the
  // review screen's "Approve all & publish" is the retry.
  needsPublishRetry: boolean;
  // Newest decision/generation for partial reviews; job creation for untouched.
  lastActivityAt: Date;
  // Who decided so far — labels the "in review by others" rows.
  reviewerEmails: string[];
  // Per-output breakdown, CROSS-JOB: every current output for the style — the
  // reviewable ones (with a document) and the still-coming ones together.
  outputs: ReviewTaskOutput[];
};

export type ReviewTaskOutput = {
  variantKey: string;
  name: string;
  // Cross-job output state (lib/outputs/current-outputs): generated states
  // (TO_REVIEW / BLOCKED / APPROVED / REJECTED) plus the still-coming ones
  // (AWAITING_DATA / READY_TO_GENERATE / GENERATING).
  state: OutputState;
  // true ⇒ a document exists to review now. false ⇒ still coming — rendered
  // muted with its reason, no "Review" link.
  generated: boolean;
  // For AWAITING_DATA rows: the field labels still missing, so the card can
  // say WHY it hasn't generated ("missing: EANs").
  missing: string[];
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

// The awaiting-review jobs, one entry per STYLE (newest job wins). Shared by
// getReviewWork (per-user buckets) and getReviewQueue (the flat queue) so both
// see the same collapse and the same task shape. The raw `job` is carried
// alongside the built task because the bucketing reads per-asset reviewer ids.
function queryAwaitingReviewJobs() {
  return db.job.findMany({
    where: { status: "AWAITING_REVIEW" },
    // This list never renders reviewEndedAt — omit it, both to trim the
    // payload (same reason queries elsewhere avoid the pdf blob) and so the
    // dashboard keeps working before the additive column is deployed.
    omit: { reviewEndedAt: true },
    include: {
      style: { include: { customer: true, businessAreaRef: true } },
      reviewClaimedBy: { select: { email: true } },
      assets: {
        select: {
          variantKey: true,
          docType: true,
          displayName: true,
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
}

type AwaitingReviewJob = Awaited<ReturnType<typeof queryAwaitingReviewJobs>>[number];

// Newest awaiting-review job per STYLE. The review screen always opens the
// newest awaiting job, so that is the actionable unit — a style re-run can
// strand older jobs in AWAITING_REVIEW, and listing those would duplicate the
// row with a CTA that opens a different job. Drops jobs that rendered nothing.
function latestPerStyle(jobs: AwaitingReviewJob[]): AwaitingReviewJob[] {
  const latest = new Map<string, AwaitingReviewJob>();
  for (const job of jobs) {
    if (!latest.has(job.styleId)) latest.set(job.styleId, job);
  }
  return [...latest.values()].filter((j) => j.assets.length > 0);
}

// Which bucket a style falls in, read off its NEWEST job — unchanged from the
// per-job model: ownership/claim is a property of the actionable job, not the
// style's whole cross-job history. Deliberately cheap (no cross-job rollup) so
// the badge poller (getReviewCounts) can stay one query.
function bucketOf(job: AwaitingReviewJob, userId: string): "mine" | "others" | "untouched" {
  const decided = job.assets.filter((a) => a.reviewStatus !== "PENDING_REVIEW");
  const touched = decided.length > 0 || job.reviewClaimedById != null;
  if (!touched) return "untouched";
  if (job.reviewClaimedById === userId || decided.some((a) => a.reviewedById === userId)) {
    return "mine";
  }
  return "others";
}

// Bucket COUNTS only — for the sidebar badge poller. No cross-job output
// fetch: the numbers come straight off the newest job per style, one query.
export async function getReviewCounts(
  userId: string,
): Promise<{ mine: number; others: number; untouched: number }> {
  const jobs = latestPerStyle(await queryAwaitingReviewJobs());
  let mine = 0;
  let others = 0;
  let untouched = 0;
  for (const job of jobs) {
    const b = bucketOf(job, userId);
    if (b === "mine") mine++;
    else if (b === "others") others++;
    else untouched++;
  }
  return { mine, others, untouched };
}

// Full per-style tasks for the CARDS (/dashboard + /reviews). Each task's
// output list, completeness and review progress are CROSS-JOB — resolved via
// getCurrentOutputsForStyle, the same source the review page renders — so a
// style whose documents landed across several runs shows its true "1 of 3
// ready, 2 still coming" picture instead of just the newest job's slice.
async function awaitingReviewEntries(): Promise<{ job: AwaitingReviewJob; task: ReviewTask }[]> {
  const jobs = latestPerStyle(await queryAwaitingReviewJobs());
  // One cross-job rollup per style. N+1 by style, but the review queue is a
  // small admin surface and parity with the review page matters more; the
  // frequent badge poll uses getReviewCounts, which skips this entirely.
  const outputsByStyle = await Promise.all(jobs.map((j) => getCurrentOutputsForStyle(j.styleId)));
  return jobs.map((job, i) => ({ job, task: buildTask(job, outputsByStyle[i]) }));
}

// A current output is "reviewable" when a document exists AND no fresh render
// is in flight — mirrors the review page's reviewable/notReady split exactly.
const isReviewable = (o: CurrentOutput) => o.jobAssetId != null && o.state !== "GENERATING";

function buildTask(job: AwaitingReviewJob, currentOutputs: CurrentOutput[]): ReviewTask {
  const reviewable = currentOutputs.filter(isReviewable);
  const decided = reviewable.filter(
    (o) => o.reviewStatus === "APPROVED" || o.reviewStatus === "REJECTED",
  );
  const stillComing = currentOutputs.filter((o) => !isReviewable(o));
  // Slot-based coverage (collapses multi-document outputs) — parity with the
  // review page's "X/Y generated" header.
  const slots = rollupOutputSlots(currentOutputs);
  const pending = reviewable.filter((o) => o.state === "TO_REVIEW" || o.state === "BLOCKED");

  // Activity = the newest of any decision, any document's generation, or the
  // claim — so "ready 2h ago" tracks the latest thing that happened.
  const lastActivity = [
    ...currentOutputs.map((o) => o.reviewedAt),
    ...currentOutputs.map((o) => o.generatedAt),
    job.reviewClaimedAt,
  ]
    .filter((d): d is Date => d != null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  // Reviewer labels + the publish-retry signal stay NEWEST-JOB properties:
  // both describe the actionable job, not the cross-job history.
  const newestDecided = job.assets.filter((a) => a.reviewStatus !== "PENDING_REVIEW");
  const newestPending = job.assets.filter((a) => a.reviewStatus === "PENDING_REVIEW");

  const outputs = currentOutputs.map(
    (o): ReviewTaskOutput => ({
      variantKey: o.variantKey,
      name: o.name,
      state: o.state,
      generated: isReviewable(o),
      missing: o.missing.map((m) => m.label),
    }),
  );
  // Reviewable documents first, still-coming ones last.
  outputs.sort((a, b) => Number(b.generated) - Number(a.generated));

  return {
    jobId: job.id,
    styleId: job.styleId,
    styleName: job.style.name,
    customerName: job.style.customer.name,
    businessArea: job.style.businessAreaRef?.name ?? job.style.businessArea ?? null,
    poNumber: job.style.poNumber ?? null,
    total: reviewable.length,
    decided: decided.length,
    stillComing: stillComing.length,
    generatedSlots: slots.generated,
    totalSlots: slots.total,
    blocked: pending.length > 0 && pending.every((o) => o.state === "BLOCKED"),
    needsPublishRetry: newestPending.length === 0,
    lastActivityAt: lastActivity ?? job.createdAt,
    reviewerEmails: Array.from(
      new Set(
        [...newestDecided.map((a) => a.reviewedBy?.email), job.reviewClaimedBy?.email].filter(
          (e): e is string => !!e,
        ),
      ),
    ),
    outputs,
  };
}

// Oldest first — the longest-stuck review is the most at risk of being
// forgotten, so it tops every list.
const byAge = (a: ReviewTask, b: ReviewTask) =>
  a.lastActivityAt.getTime() - b.lastActivityAt.getTime();

export async function getReviewWork(userId: string): Promise<ReviewWork> {
  const entries = await awaitingReviewEntries();

  const mine: ReviewTask[] = [];
  const others: ReviewTask[] = [];
  const untouched: ReviewTask[] = [];

  for (const { job, task } of entries) {
    const b = bucketOf(job, userId);
    if (b === "mine") mine.push(task);
    else if (b === "others") others.push(task);
    else untouched.push(task);
  }

  mine.sort(byAge);
  others.sort(byAge);
  untouched.sort(byAge);

  return { mine, others, untouched };
}

// The global review queue — every style currently awaiting review, regardless
// of who (if anyone) has started it, as one flat per-style list. Powers
// /reviews: the same collapse and card as the dashboard's "waiting for first
// review", but un-bucketed so the whole queue is visible in one place.
export async function getReviewQueue(): Promise<ReviewTask[]> {
  const entries = await awaitingReviewEntries();
  return entries.map((e) => e.task).sort(byAge);
}

// Relative-time formatting moved to lib/time so client components (the
// review claim chip) can share it without pulling in the db import above.
export { timeAgo } from "@/lib/time";
