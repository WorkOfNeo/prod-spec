// =====================================================
// Reviewer dashboard — the data behind /reviews/dashboard.
//
// UNIT = STYLE ("order"). This is the deliberate difference from the two
// dashboards that already exist:
//   • /settings/statistics  (review-stats.ts) — unit is the OUTPUT. "How long
//     does one document sit between generated and decided", per reviewer.
//   • /settings/style-dashboard (style-dashboard.ts) — unit is the style, but
//     the question is DELIVERY: generated → uploaded to SharePoint → emailed.
//   • this file — unit is the style, and the question is REVIEW PROGRESS:
//     where does each order stand, how long does each step take, how often is
//     it right first time, and how does that break down by client / supplier /
//     reviewer. Reviewer-reachable (canReview), not admin-only.
//
// NO NEW COLUMNS. Every number below is derived from timestamps that are
// already written on origin/main:
//   Job.createdAt              — an order was (re)generated
//   JobAsset.createdAt         — an output became reviewable
//   JobAsset.reviewedAt        — the moment it was approved / rejected
//   JobAsset.reviewedById      — who decided it
// JobAsset (not ReviewAction) is the review ledger here: ReviewAction only
// records whole-job settles and carries no REJECTED rows in production, so it
// cannot answer "first pass?" at all. See the header note in review-stats.ts,
// which reaches the same conclusion for the per-output view.
//
// computeReviewerDashboard is PURE (unit-tested in reviewer-dashboard.test.ts);
// getReviewerDashboard does the querying. db is lazy-imported inside the async
// fns so the pure half stays testable without a database — same pattern as
// style-dashboard.ts / current-outputs.ts.
// =====================================================

import type { Prisma } from "@/generated/prisma/client";
// Pure + already unit-tested; style-dashboard.ts lazy-imports db inside its
// async fns, so pulling this in keeps the pure half of this file DB-free.
import { baseKey } from "./style-dashboard";

// ---- Inputs (what the query layer hands the pure aggregator) -----------------

export type AssetReviewStatusLite = "PENDING_REVIEW" | "APPROVED" | "REJECTED";
export type JobStatusLite = "QUEUED" | "RUNNING" | "AWAITING_REVIEW" | "APPROVED" | "REJECTED" | "FAILED";

export type DashAsset = {
  jobId: string;
  variantKey: string | null;
  docType: string;
  reviewStatus: AssetReviewStatusLite;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedById: string | null;
};

export type DashJob = {
  id: string;
  status: JobStatusLite;
  createdAt: Date;
};

export type DashStyle = {
  styleId: string;
  styleName: string;
  poNumber: string | null;
  customerId: string;
  customerName: string;
  supplierId: string | null;
  supplierName: string | null;
  // Ascending by createdAt. jobs[0] is the FIRST generation of this order —
  // the anchor for "creation → first review" and for the first-pass question.
  jobs: DashJob[];
  assets: DashAsset[];
};

// ---- Filters ----------------------------------------------------------------

// A handful of decisions carry no user at all (outputs whose layout skips the
// manual queue settle with reviewedById null). Without a way to select them the
// per-person figures silently fall short of the "Everyone" total, which reads
// as broken arithmetic. Plain ASCII sentinel — see BLANK_VALUE in
// styles/table-filter.ts for why.
export const NO_PERSON = "__none__";

// The owner of one decision, as the "Decided by" filter sees it.
function ownerOf(a: DashAsset): string {
  return a.reviewedById ?? NO_PERSON;
}

export type ReviewerDashboardFilters = {
  customerId?: string | null;
  supplierId?: string | null;
  // "Decided by". A style is IN scope when this user decided at least one of
  // its outputs (NO_PERSON = decided with no user attached); decision counts
  // are then narrowed to that user's decisions only. Status buckets, step
  // timings, first-pass and turnaround stay WHOLE-ORDER — a half-reviewed
  // order is half reviewed no matter who else touched it — which is why an
  // order two people worked on is counted in full under each of them. The page
  // says so per card, and `shared` below is how many such orders there are.
  reviewerId?: string | null;
  // Item 6 — custom date range over DECISIONS (JobAsset.reviewedAt).
  from?: Date | null;
  to?: Date | null;
};

// ---- Outputs ----------------------------------------------------------------

// Item 1 — where every order stands right now.
export type StyleBucket =
  | "FULLY_REVIEWED"
  | "PARTIALLY_REVIEWED"
  | "NOT_REVIEWED"
  | "NOT_GENERATED"
  | "WAITING_FOR_INFO"
  | "ERROR";

export const STYLE_BUCKETS: StyleBucket[] = [
  "FULLY_REVIEWED",
  "PARTIALLY_REVIEWED",
  "NOT_REVIEWED",
  "NOT_GENERATED",
  "WAITING_FOR_INFO",
  "ERROR",
];

export const BUCKET_LABELS: Record<StyleBucket, string> = {
  FULLY_REVIEWED: "Fully reviewed",
  PARTIALLY_REVIEWED: "Partially reviewed",
  NOT_REVIEWED: "Not reviewed yet",
  NOT_GENERATED: "Not generated yet",
  WAITING_FOR_INFO: "Waiting for customer info",
  ERROR: "Errors",
};

export type DurationStat = { n: number; avgMs: number | null; medianMs: number | null };

// Item 3 — the three steps the brief names.
export type StepTimings = {
  creationToFirstReview: DurationStat;
  firstReviewToRegeneration: DurationStat;
  firstReviewToFinalApproval: DurationStat;
};

// Item 4 — approved first time, per look-back window.
export type FirstPassWindow = { label: string; days: number; total: number; clean: number };

// Item 5 — how long an order takes end to end.
export type TurnaroundBuckets = {
  total: number;
  within1d: number;
  within2d: number;
  withinWeek: number;
  overWeek: number;
};

// Item 6 — decisions inside a custom date range.
export type RangeActivity = { reviewed: number; approved: number; rejected: number; styles: number };

// Item 7 — per-client rollup.
export type ClientEfficiency = {
  customerId: string;
  customerName: string;
  styles: number;
  fullyReviewed: number;
  firstPassTotal: number;
  firstPassClean: number;
  firstPassRate: number | null; // 0..1
  medianTurnaroundMs: number | null;
  decided: number;
  approved: number;
  rejected: number;
  approvalRate: number | null; // 0..1
};

export type ReviewerDashboard = {
  totalStyles: number;
  // Only set when a person is selected: how many of the orders in scope were
  // ALSO decided by somebody else. Those orders are counted in full under every
  // person who touched them, so this is the amount by which the per-person
  // figures overshoot the unfiltered total. Null with no person filter.
  shared: number | null;
  buckets: Record<StyleBucket, number>;
  timings: StepTimings;
  firstPass: FirstPassWindow[];
  turnaround: TurnaroundBuckets;
  range: RangeActivity;
  clients: ClientEfficiency[];
};

// ---- Pure helpers -----------------------------------------------------------

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function stat(values: number[]): DurationStat {
  if (values.length === 0) return { n: 0, avgMs: null, medianMs: null };
  const sum = values.reduce((a, b) => a + b, 0);
  return { n: values.length, avgMs: Math.round(sum / values.length), medianMs: median(values) };
}

function decided(assets: DashAsset[]): DashAsset[] {
  return assets.filter((a) => a.reviewStatus !== "PENDING_REVIEW" && a.reviewedAt !== null);
}

/**
 * The CURRENT decision set for an order — what "fully reviewed" has to mean.
 *
 * Every re-run is a new Job row and the old job's assets survive, so the raw
 * asset list is a HISTORY, not a state. Bucketing over the history would leave
 * an order that was rejected once and fixed afterwards reading "partially
 * reviewed" forever. This applies the supersede rule: per output BASE, only the
 * newest generating job's documents count; one row per full variant key.
 *
 * Deliberately NOT selectCurrentAssets() from outputs/current-outputs.ts.
 * That helper additionally drops bases the ProdSpec no longer declares and
 * bases excluded by a doc-type keyword rule — both of which need each style's
 * parsed ProdSpec and rawData, a per-style walk far too heavy to run across the
 * whole book for a dashboard. The consequence is narrow and worth stating: an
 * order whose operator REMOVED an output after it was rejected still counts
 * that stale rejection here, where the review screen would not. Superseding by
 * newest job — the dominant case by far — is handled identically.
 */
export function currentAssets(style: DashStyle): DashAsset[] {
  if (style.assets.length === 0) return [];
  const jobOrder = new Map(style.jobs.map((j, i) => [j.id, i])); // ascending by createdAt
  const rank = (a: DashAsset) => jobOrder.get(a.jobId) ?? -1;

  const newestJobRankForBase = new Map<string, number>();
  for (const a of style.assets) {
    const b = baseKey(a.variantKey, a.docType);
    const r = rank(a);
    const seen = newestJobRankForBase.get(b);
    if (seen === undefined || r > seen) newestJobRankForBase.set(b, r);
  }

  const seenKeys = new Set<string>();
  const out: DashAsset[] = [];
  // Newest job first, so the first row seen for a full key is the current one.
  for (const a of [...style.assets].sort((x, y) => rank(y) - rank(x))) {
    const b = baseKey(a.variantKey, a.docType);
    if (rank(a) !== newestJobRankForBase.get(b)) continue; // an older generation
    const key = a.variantKey ?? `doc:${a.docType}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push(a);
  }
  return out;
}

/**
 * Item 1's classifier. Order matters — the first rule that fires wins.
 *
 * WAITING_FOR_INFO is a PROXY, and an honest one: a style that has never had a
 * job enqueued is a style the pipeline refused to generate, which in this app
 * means its Monday / PO / barcode data isn't there yet. That is exactly the
 * population the /reviews "Needs input" tab lists. We do NOT re-run the
 * per-style readiness ladder here — that walk is far too heavy for a dashboard
 * over the whole book, and "never generated" answers the reviewer's question.
 */
export function bucketStyle(style: DashStyle): StyleBucket {
  const { jobs } = style;
  // State, not history — see currentAssets().
  const assets = currentAssets(style);
  if (assets.length === 0) {
    // Nothing reviewable exists. Which of the three "not yet" states is it?
    if (jobs.length === 0) return "WAITING_FOR_INFO";
    const latest = jobs[jobs.length - 1];
    if (latest.status === "FAILED") return "ERROR";
    return "NOT_GENERATED";
  }
  const dec = decided(assets);
  if (dec.length === 0) return "NOT_REVIEWED";
  if (dec.length === assets.length && dec.every((a) => a.reviewStatus === "APPROVED")) {
    return "FULLY_REVIEWED";
  }
  return "PARTIALLY_REVIEWED";
}

/**
 * Item 3, step 1 — first generation → the first decision anyone made on it.
 * Null when the order has no job or no decision yet.
 */
export function creationToFirstReviewMs(style: DashStyle): number | null {
  const first = style.jobs[0];
  if (!first) return null;
  const times = decided(style.assets).map((a) => a.reviewedAt!.getTime());
  if (times.length === 0) return null;
  const firstDecision = Math.min(...times);
  const ms = firstDecision - first.createdAt.getTime();
  return ms >= 0 ? ms : null;
}

/**
 * Item 3, step 2 — the first rejection → the regeneration that answered it.
 * "Regeneration" is the next Job created for this style AFTER that rejection;
 * every re-run is a new Job row in this system, so the next job IS the redo.
 * Null when the order was never rejected, or was rejected and never re-run.
 */
export function firstReviewToRegenerationMs(style: DashStyle): number | null {
  const rejections = decided(style.assets)
    .filter((a) => a.reviewStatus === "REJECTED")
    .map((a) => a.reviewedAt!.getTime());
  if (rejections.length === 0) return null;
  const firstRejection = Math.min(...rejections);
  const nextJob = style.jobs.find((j) => j.createdAt.getTime() > firstRejection);
  if (!nextJob) return null;
  return nextJob.createdAt.getTime() - firstRejection;
}

/**
 * Item 3, step 3 — first decision → the order being fully approved. Only
 * measurable for orders that actually got there (FULLY_REVIEWED).
 */
export function firstReviewToFinalApprovalMs(style: DashStyle): number | null {
  if (bucketStyle(style) !== "FULLY_REVIEWED") return null;
  // Spans the WHOLE review history — the first decision ever made on this
  // order (typically a rejection on an earlier generation) to the approval
  // that closed it. Using only the current set would measure the last sitting.
  const times = decided(style.assets).map((a) => a.reviewedAt!.getTime());
  if (times.length === 0) return null;
  const ms = Math.max(...times) - Math.min(...times);
  return ms >= 0 ? ms : null;
}

/**
 * Item 5's clock — first generation → fully approved. Distinct from step 3
 * above: this one includes the wait BEFORE anyone looked at it, which is what
 * "approved within a day" means to a customer.
 */
export function totalTurnaroundMs(style: DashStyle): number | null {
  if (bucketStyle(style) !== "FULLY_REVIEWED") return null;
  const first = style.jobs[0];
  if (!first) return null;
  const times = decided(style.assets).map((a) => a.reviewedAt!.getTime());
  if (times.length === 0) return null;
  const ms = Math.max(...times) - first.createdAt.getTime();
  return ms >= 0 ? ms : null;
}

/**
 * Item 4 — was this order right the FIRST time? Looks only at the outputs of
 * the style's first job: every one decided, none rejected. Returns null when
 * the first job produced nothing decided (nothing to judge yet).
 */
export function firstPassOutcome(style: DashStyle): { clean: boolean; at: Date } | null {
  const first = style.jobs[0];
  if (!first) return null;
  const firstJobAssets = style.assets.filter((a) => a.jobId === first.id);
  const dec = decided(firstJobAssets);
  if (dec.length === 0) return null;
  const clean = dec.every((a) => a.reviewStatus === "APPROVED");
  const at = new Date(Math.max(...dec.map((a) => a.reviewedAt!.getTime())));
  return { clean, at };
}

export const FIRST_PASS_WINDOWS: { label: string; days: number }[] = [
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
  { label: "6 months", days: 182 },
  { label: "1 year", days: 365 },
];

// ---- The aggregator ---------------------------------------------------------

/**
 * Pure. Everything the dashboard renders, from a list of styles plus the
 * filters already applied at the query layer (customer / supplier narrow the
 * style list itself; reviewerId and the date range are applied HERE because
 * they scope decisions rather than orders).
 */
export function computeReviewerDashboard(
  styles: DashStyle[],
  filters: ReviewerDashboardFilters = {},
  now: Date = new Date(),
): ReviewerDashboard {
  const reviewerId = filters.reviewerId ?? null;

  // "Decided by" narrows the ORDER set to what that person has decided.
  // Membership is read off DECIDED assets only, and through ownerOf, so the
  // scope and the decision counts below can never disagree about what a
  // decision by NO_PERSON is.
  const owners = (style: DashStyle) => new Set(decided(style.assets).map(ownerOf));
  const scoped = reviewerId ? styles.filter((s) => owners(s).has(reviewerId)) : styles;
  // How many of those orders somebody ELSE also decided — the double-count.
  const shared = reviewerId ? scoped.filter((s) => owners(s).size > 1).length : null;

  const buckets = Object.fromEntries(STYLE_BUCKETS.map((b) => [b, 0])) as Record<StyleBucket, number>;

  const creation: number[] = [];
  const regen: number[] = [];
  const finalApproval: number[] = [];
  const turnarounds: number[] = [];

  const firstPass = FIRST_PASS_WINDOWS.map((w) => ({ ...w, total: 0, clean: 0 }));

  const turnaround: TurnaroundBuckets = {
    total: 0,
    within1d: 0,
    within2d: 0,
    withinWeek: 0,
    overWeek: 0,
  };

  const range: RangeActivity = { reviewed: 0, approved: 0, rejected: 0, styles: 0 };
  const from = filters.from ?? null;
  const to = filters.to ?? null;

  const byClient = new Map<string, ClientEfficiency & { turnarounds: number[] }>();

  const DAY = 86_400_000;

  for (const style of scoped) {
    buckets[bucketStyle(style)] += 1;

    const c1 = creationToFirstReviewMs(style);
    if (c1 !== null) creation.push(c1);
    const c2 = firstReviewToRegenerationMs(style);
    if (c2 !== null) regen.push(c2);
    const c3 = firstReviewToFinalApprovalMs(style);
    if (c3 !== null) finalApproval.push(c3);

    const total = totalTurnaroundMs(style);
    if (total !== null) {
      turnarounds.push(total);
      turnaround.total += 1;
      const days = total / DAY;
      if (days <= 1) turnaround.within1d += 1;
      else if (days <= 2) turnaround.within2d += 1;
      else if (days <= 7) turnaround.withinWeek += 1;
      else turnaround.overWeek += 1;
    }

    const fp = firstPassOutcome(style);
    if (fp) {
      for (const w of firstPass) {
        if (now.getTime() - fp.at.getTime() <= w.days * DAY) {
          w.total += 1;
          if (fp.clean) w.clean += 1;
        }
      }
    }

    // Item 6 — decisions inside the range, narrowed to the chosen reviewer.
    const inRange = decided(style.assets).filter((a) => {
      if (reviewerId && ownerOf(a) !== reviewerId) return false;
      const t = a.reviewedAt!.getTime();
      if (from && t < from.getTime()) return false;
      if (to && t > to.getTime()) return false;
      return true;
    });
    if (inRange.length > 0) {
      range.styles += 1;
      range.reviewed += inRange.length;
      range.approved += inRange.filter((a) => a.reviewStatus === "APPROVED").length;
      range.rejected += inRange.filter((a) => a.reviewStatus === "REJECTED").length;
    }

    // Item 7 — per-client rollup.
    let entry = byClient.get(style.customerId);
    if (!entry) {
      entry = {
        customerId: style.customerId,
        customerName: style.customerName,
        styles: 0,
        fullyReviewed: 0,
        firstPassTotal: 0,
        firstPassClean: 0,
        firstPassRate: null,
        medianTurnaroundMs: null,
        decided: 0,
        approved: 0,
        rejected: 0,
        approvalRate: null,
        turnarounds: [],
      };
      byClient.set(style.customerId, entry);
    }
    entry.styles += 1;
    if (bucketStyle(style) === "FULLY_REVIEWED") entry.fullyReviewed += 1;
    if (fp) {
      entry.firstPassTotal += 1;
      if (fp.clean) entry.firstPassClean += 1;
    }
    if (total !== null) entry.turnarounds.push(total);
    // The SAME decision set the range card counts — person and date range both
    // applied. Reusing inRange is the point: two cards on one page disagreeing
    // about how many outputs were decided is the complaint this fixes.
    entry.decided += inRange.length;
    entry.approved += inRange.filter((a) => a.reviewStatus === "APPROVED").length;
    entry.rejected += inRange.filter((a) => a.reviewStatus === "REJECTED").length;
  }

  const clients: ClientEfficiency[] = [...byClient.values()]
    .map(({ turnarounds: ts, ...c }) => ({
      ...c,
      firstPassRate: c.firstPassTotal > 0 ? c.firstPassClean / c.firstPassTotal : null,
      medianTurnaroundMs: median(ts),
      approvalRate: c.decided > 0 ? c.approved / c.decided : null,
    }))
    .sort((a, b) => b.styles - a.styles);

  return {
    totalStyles: scoped.length,
    shared,
    buckets,
    timings: {
      creationToFirstReview: stat(creation),
      firstReviewToRegeneration: stat(regen),
      firstReviewToFinalApproval: stat(finalApproval),
    },
    firstPass,
    turnaround,
    range,
    clients,
  };
}

// ---- Query layer ------------------------------------------------------------

export type FilterOption = { id: string; name: string };
export type ReviewerDashboardOptions = {
  customers: FilterOption[];
  suppliers: FilterOption[];
  reviewers: FilterOption[];
  // Are there decided outputs with no user attached? Only then is the
  // "(no person)" entry worth offering — an empty picker entry helps nobody.
  hasUnattributed: boolean;
};

/**
 * The dropdown contents. Reviewers only ever appear here if they have actually
 * decided something.
 */
export async function getReviewerDashboardOptions(): Promise<ReviewerDashboardOptions> {
  const { db } = await import("@/lib/db");
  const DECIDED: Prisma.JobAssetWhereInput = {
    reviewStatus: { in: ["APPROVED", "REJECTED"] },
    reviewedAt: { not: null },
  };
  const [customers, suppliers, reviewerIds, unattributed] = await Promise.all([
    db.customer.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.supplier.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.jobAsset.findMany({
      where: { reviewedById: { not: null } },
      select: { reviewedById: true },
      distinct: ["reviewedById"],
    }),
    db.jobAsset.count({ where: { ...DECIDED, reviewedById: null } }),
  ]);
  const ids = reviewerIds.map((r) => r.reviewedById!).filter(Boolean);
  const users = ids.length
    ? await db.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true },
        orderBy: { name: "asc" },
      })
    : [];
  return {
    customers: customers.map((c) => ({ id: c.id, name: c.name })),
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name })),
    reviewers: users.map((u) => ({ id: u.id, name: u.name || u.email })),
    hasUnattributed: unattributed > 0,
  };
}

/**
 * Load + aggregate. Customer / supplier filter the STYLE set in SQL; reviewer
 * and date range are applied in the pure aggregator (they scope decisions).
 *
 * Jobs and assets are fetched through a RELATION filter rather than an `in`
 * list of style ids — the unfiltered book is ~5.8k styles and threading that
 * many ids through three queries is needless.
 */
export async function getReviewerDashboard(
  filters: ReviewerDashboardFilters = {},
): Promise<{ data: ReviewerDashboard; scopedStyles: number }> {
  const { db } = await import("@/lib/db");
  const { activeStylesWhere } = await import("@/lib/styles/active-filter");

  const base = await activeStylesWhere();
  const where: Prisma.StyleWhereInput = {
    ...base,
    ...(filters.customerId ? { customerId: filters.customerId } : {}),
    ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
  };

  const [styles, jobs, assets] = await Promise.all([
    db.style.findMany({
      where,
      select: {
        id: true,
        name: true,
        poNumber: true,
        customerId: true,
        customer: { select: { name: true } },
        supplierId: true,
        supplier: { select: { name: true } },
      },
    }),
    db.job.findMany({
      where: { style: where },
      // select (not include) so Job.reviewEndedAt is never read — it's an
      // additive column and this surface has no use for it.
      select: { id: true, styleId: true, status: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    db.jobAsset.findMany({
      where: { job: { style: where } },
      select: {
        jobId: true,
        variantKey: true,
        docType: true,
        reviewStatus: true,
        createdAt: true,
        reviewedAt: true,
        reviewedById: true,
      },
    }),
  ]);

  const jobsByStyle = new Map<string, DashJob[]>();
  const styleByJob = new Map<string, string>();
  for (const j of jobs) {
    styleByJob.set(j.id, j.styleId);
    const list = jobsByStyle.get(j.styleId);
    // Already ordered ascending by the query.
    if (list) list.push({ id: j.id, status: j.status, createdAt: j.createdAt });
    else jobsByStyle.set(j.styleId, [{ id: j.id, status: j.status, createdAt: j.createdAt }]);
  }

  const assetsByStyle = new Map<string, DashAsset[]>();
  for (const a of assets) {
    const styleId = styleByJob.get(a.jobId);
    if (!styleId) continue;
    const row: DashAsset = {
      jobId: a.jobId,
      variantKey: a.variantKey,
      docType: a.docType,
      reviewStatus: a.reviewStatus,
      createdAt: a.createdAt,
      reviewedAt: a.reviewedAt,
      reviewedById: a.reviewedById,
    };
    const list = assetsByStyle.get(styleId);
    if (list) list.push(row);
    else assetsByStyle.set(styleId, [row]);
  }

  const rows: DashStyle[] = styles.map((s) => ({
    styleId: s.id,
    styleName: s.name,
    poNumber: s.poNumber,
    customerId: s.customerId,
    customerName: s.customer?.name ?? "—",
    supplierId: s.supplierId,
    supplierName: s.supplier?.name ?? null,
    jobs: jobsByStyle.get(s.id) ?? [],
    assets: assetsByStyle.get(s.id) ?? [],
  }));

  return { data: computeReviewerDashboard(rows, filters), scopedStyles: rows.length };
}
