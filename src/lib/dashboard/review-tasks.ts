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
  // The prod spec this style is on — the grouping key for the /reviews queue
  // (null when the style has no active prod spec). prodSpecName labels the group.
  prodSpecId: string | null;
  prodSpecName: string | null;
  poNumber: string | null;
  // Fresh worklist counts. `total` = documents still needing a decision now
  // (to-review / blocked), the number the card shows as "N to review" — it
  // EXCLUDES already-decided (approved/rejected) outputs so the list shrinks as
  // you work. `decided` = decisions already made on the newest (actionable)
  // job; used only to label the CTA ("Finish review" mid-pass). Still-coming
  // documents aren't counted in `total`; they live in `stillComing`.
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

// A group of styles awaiting their FIRST review, collected under the prod spec
// they share. A ProdSpec is unique per customer × business area, so a group is
// exactly a "category" (Netto · Private Label, …). Powers the /reviews "Review"
// tab; "In Progress" is a flat list, not grouped.
export type ReviewGroup = {
  // prodSpecId, or a synthetic customer×BA key for styles with no prod spec.
  key: string;
  prodSpecId: string | null;
  prodSpecName: string | null;
  customerName: string;
  businessArea: string | null;
  tasks: ReviewTask[];
};

// The awaiting-review jobs, one entry per STYLE (newest job wins). Shared by
// getReviewWork (per-user buckets) and getReviewBoard (the /reviews two tabs)
// so both see the same collapse and the same task shape. The raw `job` is carried
// alongside the built task because the bucketing reads per-asset reviewer ids.
function queryAwaitingReviewJobs() {
  return db.job.findMany({
    where: { status: "AWAITING_REVIEW" },
    // This list never renders reviewEndedAt — omit it, both to trim the
    // payload (same reason queries elsewhere avoid the pdf blob) and so the
    // dashboard keeps working before the additive column is deployed.
    omit: { reviewEndedAt: true },
    include: {
      style: {
        include: {
          customer: true,
          businessAreaRef: true,
          // ProdSpec identity drives the /reviews grouping — a ProdSpec is
          // unique per customer × business area, so grouping by it is exactly
          // grouping by category (Netto · Private Label, …).
          prodSpec: { select: { id: true, name: true } },
        },
      },
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
  // The card is a FRESH worklist: it shows only what still needs a decision
  // (to-review / blocked) plus what's still coming, and hides settled outputs
  // (approved / rejected). So when a style is rerun for one fix, the reviewer
  // sees that one — not the 34 already decided in a prior run. The settled
  // history stays in full on the per-style review page. NOTE: this hides BOTH
  // states regardless of run, so the list "gets less and less" as you decide.
  const isSettled = (o: CurrentOutput) => o.state === "APPROVED" || o.state === "REJECTED";
  const fresh = currentOutputs.filter((o) => !isSettled(o));
  // Needs a decision now: a fresh document that exists and isn't regenerating.
  const pending = fresh.filter(isReviewable);
  const stillComing = fresh.filter((o) => !isReviewable(o));
  // Slot-based generation coverage — kept over the FULL set so "3/5 generated"
  // still reflects true coverage of the style's declared outputs.
  const slots = rollupOutputSlots(currentOutputs);

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
  // both describe the actionable job, not the cross-job history. `decided`
  // counts the newest job's decisions so the CTA can read "Finish review"
  // mid-pass even though those decided documents have dropped off the list.
  const newestDecided = job.assets.filter((a) => a.reviewStatus !== "PENDING_REVIEW");
  const newestPending = job.assets.filter((a) => a.reviewStatus === "PENDING_REVIEW");

  const outputs = fresh.map(
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
    prodSpecId: job.style.prodSpecId ?? null,
    prodSpecName: job.style.prodSpec?.name ?? null,
    poNumber: job.style.poNumber ?? null,
    total: pending.length,
    decided: newestDecided.length,
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

// Most-recent activity first — In Progress is a live worklist, so the style
// just regenerated or decided should surface at the top.
const byRecency = (a: ReviewTask, b: ReviewTask) =>
  b.lastActivityAt.getTime() - a.lastActivityAt.getTime();

// "Started" = the global form of bucketOf's `touched`: a review is underway on
// the newest job (claimed, or ≥1 document already decided), regardless of WHO
// started it. Drives the Review → In Progress split.
const isStarted = (job: AwaitingReviewJob) =>
  job.reviewClaimedById != null ||
  job.assets.some((a) => a.reviewStatus !== "PENDING_REVIEW");

// Live DB has BusinessArea rows literally named "–" (and free-text blanks);
// blank those out for the group LABEL so a category header never reads as junk.
// Grouping keys on prodSpecId, so this is display-only.
const normalizeBa = (ba: string | null): string | null => {
  const t = (ba ?? "").trim();
  return t === "" || t === "–" || t === "-" ? null : t;
};

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

// The /reviews board — ONE fetch, both tabs. Splits the awaiting-review styles
// into the untouched queue (grouped by prod spec) and the shared In Progress
// list (any style whose review has been STARTED, or that still has an
// unresolved rejection being reworked). Same per-style collapse and card shape
// as the dashboard; the awaiting-review fetch is the same one the flat queue
// used, so both tab counts come from a single pass.
export async function getReviewBoard(): Promise<{
  groups: ReviewGroup[];
  inProgress: ReviewTask[];
}> {
  const entries = await awaitingReviewEntries();

  // Durable rework signal: a rejected style's fix re-run creates a NEW, unclaimed
  // job that on its own would look "untouched" and fall back to the queue. An
  // open RejectionTicket (anything not RESOLVED) keeps the style in In Progress
  // across that regeneration gap — approving the fix resolves the ticket and
  // settles the job, so it leaves on its own. One indexed query, no Bytes.
  const styleIds = entries.map((e) => e.job.styleId);
  const reworkingRows = styleIds.length
    ? await db.rejectionTicket.findMany({
        where: { styleId: { in: styleIds }, status: { not: "RESOLVED" } },
        select: { styleId: true },
      })
    : [];
  const reworking = new Set(reworkingRows.map((r) => r.styleId));

  const inProgress: ReviewTask[] = [];
  const untouched: ReviewTask[] = [];
  for (const { job, task } of entries) {
    if (isStarted(job) || reworking.has(job.styleId)) inProgress.push(task);
    else untouched.push(task);
  }

  // Group the untouched queue by prod spec (== customer × business area). Styles
  // with no prod spec fall into a synthetic per-customer/BA group so the queue
  // never silently drops a style.
  const byKey = new Map<string, ReviewGroup>();
  for (const task of untouched) {
    const key = task.prodSpecId ?? `cust:${task.customerName}|ba:${task.businessArea ?? ""}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        prodSpecId: task.prodSpecId,
        prodSpecName: task.prodSpecName,
        customerName: task.customerName,
        businessArea: normalizeBa(task.businessArea),
        tasks: [],
      };
      byKey.set(key, group);
    }
    group.tasks.push(task);
  }

  const groups = [...byKey.values()];
  for (const g of groups) g.tasks.sort(byAge);
  // Most-stuck category first: order groups by their oldest waiting style.
  groups.sort(
    (a, b) => a.tasks[0].lastActivityAt.getTime() - b.tasks[0].lastActivityAt.getTime(),
  );

  inProgress.sort(byRecency);
  return { groups, inProgress };
}

// Relative-time formatting moved to lib/time so client components (the
// review claim chip) can share it without pulling in the db import above.
export { timeAgo } from "@/lib/time";
