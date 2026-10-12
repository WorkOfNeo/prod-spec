import { db } from "@/lib/db";
import {
  getCurrentOutputsForStyles,
  rollupOutputSlots,
  type CurrentOutput,
  type OutputState,
} from "@/lib/outputs/current-outputs";
import { mondayItemUrl } from "@/lib/monday/url";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import {
  styleReadinessNotice,
  type ReadinessNotice,
} from "@/lib/styles/readiness-notice";

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
  // Deep link to the style's Monday item — the reviewer's remedy for the
  // readiness notice's "add it on Monday" steps (missing required fields, no PO
  // number). Both ids are always present on a Style (mondayItemId is unique,
  // mondayBoardId required), so this is never null.
  mondayUrl: string;
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
  // The role-aware Output Readiness Notice — the single model that folds the
  // whole pipeline (SharePoint → PO → EANs → fields → generation → review) into
  // a headline pill + step ladder. Computed server-side from the SAME cross-job
  // currentOutputs the card already renders, so it supersedes the ad-hoc
  // "X/Y generated" badge, the "still coming" paragraph and the per-output
  // "missing …" text. Plain data → safe to pass into the client card.
  notice: ReadinessNotice;
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

// The awaiting-review jobs in the slim shape the bucketing reads — newest
// first, all of them (latestPerStyle collapses). ONE query shared by
// getReviewCounts (the badge), getReviewWork (per-user buckets) and
// getReviewBoard (the /reviews tabs), so all three see the same collapse and
// the same buckets. It carries nothing a card renders: the badge poller runs it
// every 60s per open tab, and cards load their own fields for just the jobs
// they show (queryCardJobs). `select` (not include) also keeps the additive
// reviewEndedAt column out, so this works before that column is deployed.
function queryAwaitingReviewHeads() {
  return db.job.findMany({
    where: { status: "AWAITING_REVIEW" },
    select: {
      id: true,
      styleId: true,
      reviewClaimedById: true,
      assets: { select: { reviewStatus: true, reviewedById: true } },
    },
    orderBy: { createdAt: "desc" },
  });
}

type AwaitingReviewHead = Awaited<ReturnType<typeof queryAwaitingReviewHeads>>[number];

// The fields the bucketing reads off a job. Structural, so the badge, the
// cards and the tests all run the same functions on whatever shape they load.
export type BucketableJob = {
  styleId: string;
  reviewClaimedById: string | null;
  assets: ReadonlyArray<{ reviewStatus: string; reviewedById: string | null }>;
};

export type ReviewBucket = keyof ReviewWork;

// Newest awaiting-review job per STYLE (input newest first). The review screen
// always opens the newest awaiting job, so that is the actionable unit — a
// style re-run can strand older jobs in AWAITING_REVIEW, and listing those
// would duplicate the row with a CTA that opens a different job. Drops jobs
// that rendered nothing.
export function latestPerStyle<J extends BucketableJob>(jobs: J[]): J[] {
  const latest = new Map<string, J>();
  for (const job of jobs) {
    if (!latest.has(job.styleId)) latest.set(job.styleId, job);
  }
  return [...latest.values()].filter((j) => j.assets.length > 0);
}

// Which bucket a style falls in, read off its NEWEST job — unchanged from the
// per-job model: ownership/claim is a property of the actionable job, not the
// style's whole cross-job history. Deliberately cheap (no cross-job rollup) so
// every caller can bucket the whole queue before building any card.
export function bucketOf(job: BucketableJob, userId: string): ReviewBucket {
  const decided = job.assets.filter((a) => a.reviewStatus !== "PENDING_REVIEW");
  const touched = decided.length > 0 || job.reviewClaimedById != null;
  if (!touched) return "untouched";
  if (job.reviewClaimedById === userId || decided.some((a) => a.reviewedById === userId)) {
    return "mine";
  }
  return "others";
}

// Bucket COUNTS only — for the sidebar badge poller. No cards, no cross-job
// output fetch: the numbers come straight off the newest job per style.
export async function getReviewCounts(
  userId: string,
): Promise<{ mine: number; others: number; untouched: number }> {
  const jobs = latestPerStyle(await queryAwaitingReviewHeads());
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

// What a card needs beyond the head it was bucketed from, and nothing more —
// no customer config, no style rawData — for just the jobs a caller shows. The
// per-asset decisions come from the head itself, so a card always agrees with
// the bucket it sits in.
function queryCardJobs(jobIds: string[]) {
  return db.job.findMany({
    where: { id: { in: jobIds } },
    select: {
      id: true,
      createdAt: true,
      reviewClaimedAt: true,
      style: {
        select: {
          name: true,
          businessArea: true,
          prodSpecId: true,
          poNumber: true,
          poFileName: true,
          eanStatus: true,
          eanAttempts: true,
          mondayBoardId: true,
          mondayItemId: true,
          customer: { select: { name: true } },
          businessAreaRef: { select: { name: true } },
          // ProdSpec identity drives the /reviews grouping — a ProdSpec is
          // unique per customer × business area, so grouping by it is exactly
          // grouping by category (Netto · Private Label, …). `outputs` lets
          // the readiness notice tell whether the spec has any enabled outputs
          // (prodSpecHasOutputs).
          prodSpec: { select: { name: true, outputs: true } },
        },
      },
    },
  });
}

type CardJob = Awaited<ReturnType<typeof queryCardJobs>>[number];

const isDecided = (a: { reviewStatus: string }) => a.reviewStatus !== "PENDING_REVIEW";

// Full tasks for the CARDS of the given newest jobs, keyed by job id. Each
// task's output list, completeness and review progress are CROSS-JOB —
// resolved via getCurrentOutputsForStyles, the batch twin of the read the
// review page renders — so a style whose documents landed across several runs
// shows its true "1 of 3 ready, 2 still coming" picture instead of just the
// newest job's slice. One query per kind for the whole list, not per style.
// A job deleted between the reads simply has no entry.
async function buildTasks(jobs: AwaitingReviewHead[]): Promise<Map<string, ReviewTask>> {
  const tasks = new Map<string, ReviewTask>();
  if (jobs.length === 0) return tasks;
  // Reviewer labels need emails for the claimers and deciders only.
  const userIds = [
    ...new Set(
      jobs.flatMap((j) => [
        j.reviewClaimedById,
        ...j.assets.filter(isDecided).map((a) => a.reviewedById),
      ]),
    ),
  ].filter((id): id is string => id != null);
  const [cards, users, outputsByStyle] = await Promise.all([
    queryCardJobs(jobs.map((j) => j.id)),
    userIds.length > 0
      ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
      : [],
    getCurrentOutputsForStyles(jobs.map((j) => j.styleId)),
  ]);
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const emailById = new Map(users.map((u) => [u.id, u.email]));
  for (const job of jobs) {
    const card = cardById.get(job.id);
    if (!card) continue;
    tasks.set(job.id, buildTask(job, card, emailById, outputsByStyle.get(job.styleId) ?? []));
  }
  return tasks;
}

// The built tasks for `jobs`, in the order of `jobs`.
const tasksFor = (jobs: AwaitingReviewHead[], tasks: Map<string, ReviewTask>): ReviewTask[] =>
  jobs.flatMap((j) => tasks.get(j.id) ?? []);

// A current output is "reviewable" when a document exists AND no fresh render
// is in flight — mirrors the review page's reviewable/notReady split exactly.
const isReviewable = (o: CurrentOutput) => o.jobAssetId != null && o.state !== "GENERATING";

function buildTask(
  job: AwaitingReviewHead,
  card: CardJob,
  emailById: ReadonlyMap<string, string>,
  currentOutputs: CurrentOutput[],
): ReviewTask {
  const { style } = card;
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
    card.reviewClaimedAt,
  ]
    .filter((d): d is Date => d != null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  // Reviewer labels + the publish-retry signal stay NEWEST-JOB properties:
  // both describe the actionable job, not the cross-job history. `decided`
  // counts the newest job's decisions so the CTA can read "Finish review"
  // mid-pass even though those decided documents have dropped off the list.
  const newestDecided = job.assets.filter(isDecided);
  const newestPending = job.assets.filter((a) => !isDecided(a));
  const emailOf = (userId: string | null) => (userId ? emailById.get(userId) : undefined);

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

  // Role-aware readiness notice. These cards are the reviewer inbox, so the
  // REVIEWER role is the correct default (missing required fields read as Monday
  // data the reviewer adds themselves). Built from the FULL cross-job output set
  // — not `fresh` — so the source/spec/generation/review/excluded ladder reflects
  // the style's whole picture, matching the per-style review page.
  const prodSpecOutputs = parseProdSpecOutputs(style.prodSpec?.outputs ?? []);
  const notice = styleReadinessNotice(
    {
      eanStatus: style.eanStatus,
      eanAttempts: style.eanAttempts,
      poNumber: style.poNumber,
      poFileName: style.poFileName,
      hasProdSpec: style.prodSpec != null,
      prodSpecHasOutputs: prodSpecOutputs.some((o) => o.enabled !== false),
      currentOutputs,
    },
    "REVIEWER",
  );

  return {
    jobId: job.id,
    styleId: job.styleId,
    styleName: style.name,
    customerName: style.customer.name,
    businessArea: style.businessAreaRef?.name ?? style.businessArea ?? null,
    prodSpecId: style.prodSpecId ?? null,
    prodSpecName: style.prodSpec?.name ?? null,
    poNumber: style.poNumber ?? null,
    mondayUrl: mondayItemUrl(style.mondayBoardId, style.mondayItemId) ?? "",
    total: pending.length,
    decided: newestDecided.length,
    stillComing: stillComing.length,
    generatedSlots: slots.generated,
    totalSlots: slots.total,
    blocked: pending.length > 0 && pending.every((o) => o.state === "BLOCKED"),
    needsPublishRetry: newestPending.length === 0,
    lastActivityAt: lastActivity ?? card.createdAt,
    reviewerEmails: Array.from(
      new Set(
        [
          ...newestDecided.map((a) => emailOf(a.reviewedById)),
          emailOf(job.reviewClaimedById),
        ].filter((e): e is string => !!e),
      ),
    ),
    outputs,
    notice,
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
const isStarted = (job: BucketableJob) =>
  job.reviewClaimedById != null ||
  job.assets.some((a) => a.reviewStatus !== "PENDING_REVIEW");

// Live DB has BusinessArea rows literally named "–" (and free-text blanks);
// blank those out for the group LABEL so a category header never reads as junk.
// Grouping keys on prodSpecId, so this is display-only.
const normalizeBa = (ba: string | null): string | null => {
  const t = (ba ?? "").trim();
  return t === "" || t === "–" || t === "-" ? null : t;
};

const ALL_BUCKETS: readonly ReviewBucket[] = ["mine", "others", "untouched"];

// The per-user buckets, with cards built only for the buckets asked for:
// /dashboard shows mine + others, so the untouched queue — the biggest bucket,
// shown on /reviews instead — is bucketed but never built for it. Without
// `buckets`, all three come back.
export async function getReviewWork<B extends ReviewBucket = ReviewBucket>(
  userId: string,
  opts: { buckets?: readonly B[] } = {},
): Promise<Pick<ReviewWork, B>> {
  const wanted = new Set<ReviewBucket>(opts.buckets ?? ALL_BUCKETS);
  const jobs = latestPerStyle(await queryAwaitingReviewHeads());

  const jobsByBucket = new Map<ReviewBucket, AwaitingReviewHead[]>(
    [...wanted].map((b) => [b, []]),
  );
  for (const job of jobs) jobsByBucket.get(bucketOf(job, userId))?.push(job);

  const tasks = await buildTasks([...jobsByBucket.values()].flat());
  const work: Partial<ReviewWork> = {};
  for (const [bucket, bucketJobs] of jobsByBucket) {
    work[bucket] = tasksFor(bucketJobs, tasks).sort(byAge);
  }
  return work as Pick<ReviewWork, B>;
}

export type ReviewBoardList = "queue" | "inProgress";

// The /reviews board — ONE bucketing pass, both tabs. Splits the awaiting-review
// styles into the untouched queue (grouped by prod spec) and the shared In
// Progress list (any style whose review has been STARTED, or that still has an
// unresolved rejection being reworked). Same per-style collapse and card shape
// as the dashboard. Both tab counts always come back; cards are built only for
// the `cards` lists asked for (default both), since the page shows one tab.
export async function getReviewBoard(opts: { cards?: readonly ReviewBoardList[] } = {}): Promise<{
  groups: ReviewGroup[];
  inProgress: ReviewTask[];
  queueCount: number;
  inProgressCount: number;
}> {
  const wanted = new Set<ReviewBoardList>(opts.cards ?? ["queue", "inProgress"]);
  const jobs = latestPerStyle(await queryAwaitingReviewHeads());

  // Durable rework signal: a rejected style's fix re-run creates a NEW, unclaimed
  // job that on its own would look "untouched" and fall back to the queue. An
  // open RejectionTicket (anything not RESOLVED) keeps the style in In Progress
  // across that regeneration gap — approving the fix resolves the ticket and
  // settles the job, so it leaves on its own. One indexed query, no Bytes.
  const styleIds = jobs.map((j) => j.styleId);
  const reworkingRows = styleIds.length
    ? await db.rejectionTicket.findMany({
        where: { styleId: { in: styleIds }, status: { not: "RESOLVED" } },
        select: { styleId: true },
      })
    : [];
  const reworking = new Set(reworkingRows.map((r) => r.styleId));

  const inProgressJobs: AwaitingReviewHead[] = [];
  const queueJobs: AwaitingReviewHead[] = [];
  for (const job of jobs) {
    if (isStarted(job) || reworking.has(job.styleId)) inProgressJobs.push(job);
    else queueJobs.push(job);
  }

  const tasks = await buildTasks([
    ...(wanted.has("inProgress") ? inProgressJobs : []),
    ...(wanted.has("queue") ? queueJobs : []),
  ]);
  const inProgress = wanted.has("inProgress") ? tasksFor(inProgressJobs, tasks) : [];
  const untouched = wanted.has("queue") ? tasksFor(queueJobs, tasks) : [];

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
  return {
    groups,
    inProgress,
    queueCount: queueJobs.length,
    inProgressCount: inProgressJobs.length,
  };
}

// Relative-time formatting moved to lib/time so client components (the
// review claim chip) can share it without pulling in the db import above.
export { timeAgo } from "@/lib/time";
