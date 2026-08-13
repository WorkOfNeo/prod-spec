import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketStyle,
  computeReviewerDashboard,
  creationToFirstReviewMs,
  firstPassOutcome,
  firstReviewToRegenerationMs,
  firstReviewToFinalApprovalMs,
  median,
  totalTurnaroundMs,
  type DashAsset,
  type DashStyle,
} from "./reviewer-dashboard";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = new Date("2026-08-01T09:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

function asset(
  jobId: string,
  reviewStatus: DashAsset["reviewStatus"],
  opts: { createdAt?: number; reviewedAt?: number | null; by?: string | null } = {},
): DashAsset {
  return {
    jobId,
    reviewStatus,
    createdAt: at(opts.createdAt ?? 0),
    reviewedAt: opts.reviewedAt == null ? null : at(opts.reviewedAt),
    reviewedById: opts.by === undefined ? "u-dilip" : opts.by,
  };
}

function style(over: Partial<DashStyle> = {}): DashStyle {
  return {
    styleId: "s1",
    styleName: "Style 1",
    poNumber: "60001",
    customerId: "c1",
    customerName: "Netto",
    supplierId: "sup1",
    supplierName: "Supplier A",
    jobs: [{ id: "j1", status: "AWAITING_REVIEW", createdAt: T0 }],
    assets: [],
    ...over,
  };
}

// ---- The empty case ---------------------------------------------------------

test("computeReviewerDashboard — empty input yields zeroes, never NaN or a crash", () => {
  const d = computeReviewerDashboard([], {}, at(0));
  assert.equal(d.totalStyles, 0);
  for (const bucket of Object.values(d.buckets)) assert.equal(bucket, 0);
  assert.deepEqual(d.timings.creationToFirstReview, { n: 0, avgMs: null, medianMs: null });
  assert.deepEqual(d.timings.firstReviewToRegeneration, { n: 0, avgMs: null, medianMs: null });
  assert.deepEqual(d.timings.firstReviewToFinalApproval, { n: 0, avgMs: null, medianMs: null });
  assert.equal(d.turnaround.total, 0);
  assert.deepEqual(d.range, { reviewed: 0, approved: 0, rejected: 0, styles: 0 });
  assert.deepEqual(d.clients, []);
  // Every first-pass window is present but empty — the bars render at 0%, they
  // don't disappear.
  assert.equal(d.firstPass.length, 4);
  for (const w of d.firstPass) {
    assert.equal(w.total, 0);
    assert.equal(w.clean, 0);
  }
});

test("median — empty list is null, odd picks the middle, even averages the pair", () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 3, 5, 7]), 4);
});

// ---- The partially-reviewed style ------------------------------------------

// One order, one generation, three outputs: one approved, one rejected, one
// still pending. This is the case the brief calls out, and it must land in
// PARTIALLY_REVIEWED — not "fully" (a pending output is outstanding) and not
// "not reviewed" (two decisions were made).
function partiallyReviewed(): DashStyle {
  return style({
    assets: [
      asset("j1", "APPROVED", { reviewedAt: 2 * HOUR }),
      asset("j1", "REJECTED", { reviewedAt: 3 * HOUR }),
      asset("j1", "PENDING_REVIEW"),
    ],
  });
}

test("bucketStyle — a style with approved + rejected + pending outputs is PARTIALLY_REVIEWED", () => {
  assert.equal(bucketStyle(partiallyReviewed()), "PARTIALLY_REVIEWED");
});

test("partially reviewed — creation→first review measures the EARLIEST decision", () => {
  assert.equal(creationToFirstReviewMs(partiallyReviewed()), 2 * HOUR);
});

test("partially reviewed — no final-approval or turnaround number until it is fully approved", () => {
  const s = partiallyReviewed();
  assert.equal(firstReviewToFinalApprovalMs(s), null);
  assert.equal(totalTurnaroundMs(s), null);
});

test("partially reviewed — it is NOT a clean first pass, and it counts in the denominator", () => {
  const fp = firstPassOutcome(partiallyReviewed());
  assert.ok(fp);
  assert.equal(fp.clean, false);
  // Stamped at the latest decision on the first job.
  assert.equal(fp.at.getTime(), at(3 * HOUR).getTime());
});

test("partially reviewed — the dashboard rollup counts it once, in one bucket", () => {
  const d = computeReviewerDashboard([partiallyReviewed()], {}, at(4 * HOUR));
  assert.equal(d.totalStyles, 1);
  assert.equal(d.buckets.PARTIALLY_REVIEWED, 1);
  assert.equal(d.buckets.FULLY_REVIEWED, 0);
  assert.equal(d.buckets.NOT_REVIEWED, 0);
  // Two decisions were made on it, one of each.
  assert.equal(d.range.reviewed, 2);
  assert.equal(d.range.approved, 1);
  assert.equal(d.range.rejected, 1);
  assert.equal(d.range.styles, 1);
  // The client rollup sees a 0% first-pass rate, and no turnaround yet.
  assert.equal(d.clients.length, 1);
  assert.equal(d.clients[0].firstPassTotal, 1);
  assert.equal(d.clients[0].firstPassClean, 0);
  assert.equal(d.clients[0].firstPassRate, 0);
  assert.equal(d.clients[0].medianTurnaroundMs, null);
  assert.equal(d.clients[0].approvalRate, 0.5);
});

// ---- Bucketing, the rest of the ladder --------------------------------------

test("bucketStyle — no job ever enqueued reads as WAITING_FOR_INFO", () => {
  assert.equal(bucketStyle(style({ jobs: [], assets: [] })), "WAITING_FOR_INFO");
});

test("bucketStyle — a job that produced nothing is NOT_GENERATED, a FAILED one is an ERROR", () => {
  assert.equal(bucketStyle(style({ jobs: [{ id: "j1", status: "QUEUED", createdAt: T0 }] })), "NOT_GENERATED");
  assert.equal(bucketStyle(style({ jobs: [{ id: "j1", status: "FAILED", createdAt: T0 }] })), "ERROR");
});

test("bucketStyle — outputs generated but nothing decided is NOT_REVIEWED", () => {
  assert.equal(bucketStyle(style({ assets: [asset("j1", "PENDING_REVIEW")] })), "NOT_REVIEWED");
});

test("bucketStyle — every output approved is FULLY_REVIEWED", () => {
  const s = style({
    assets: [
      asset("j1", "APPROVED", { reviewedAt: HOUR }),
      asset("j1", "APPROVED", { reviewedAt: 2 * HOUR }),
    ],
  });
  assert.equal(bucketStyle(s), "FULLY_REVIEWED");
  assert.equal(firstReviewToFinalApprovalMs(s), HOUR);
  assert.equal(totalTurnaroundMs(s), 2 * HOUR);
});

test("bucketStyle — a decided-but-rejected style stays PARTIALLY_REVIEWED, never fully", () => {
  const s = style({ assets: [asset("j1", "REJECTED", { reviewedAt: HOUR })] });
  assert.equal(bucketStyle(s), "PARTIALLY_REVIEWED");
});

// ---- Step 2: the regeneration lag -------------------------------------------

test("firstReviewToRegenerationMs — measures the first rejection to the NEXT job", () => {
  const s = style({
    jobs: [
      { id: "j1", status: "REJECTED", createdAt: T0 },
      { id: "j2", status: "AWAITING_REVIEW", createdAt: at(10 * HOUR) },
    ],
    assets: [asset("j1", "REJECTED", { reviewedAt: 4 * HOUR })],
  });
  assert.equal(firstReviewToRegenerationMs(s), 6 * HOUR);
});

test("firstReviewToRegenerationMs — null when never rejected, and when rejected but never re-run", () => {
  assert.equal(
    firstReviewToRegenerationMs(style({ assets: [asset("j1", "APPROVED", { reviewedAt: HOUR })] })),
    null,
  );
  assert.equal(
    firstReviewToRegenerationMs(style({ assets: [asset("j1", "REJECTED", { reviewedAt: HOUR })] })),
    null,
  );
});

// ---- Item 5: turnaround bucketing -------------------------------------------

test("turnaround buckets — each order lands in exactly one band", () => {
  const approvedAfter = (id: string, ms: number) =>
    style({
      styleId: id,
      assets: [asset("j1", "APPROVED", { reviewedAt: ms })],
    });
  const d = computeReviewerDashboard(
    [
      approvedAfter("a", 6 * HOUR), // ≤ 1 day
      approvedAfter("b", 36 * HOUR), // ≤ 2 days
      approvedAfter("c", 5 * DAY), // ≤ 1 week
      approvedAfter("d", 20 * DAY), // over a week
    ],
    {},
    at(21 * DAY),
  );
  assert.deepEqual(d.turnaround, {
    total: 4,
    within1d: 1,
    within2d: 1,
    withinWeek: 1,
    overWeek: 1,
  });
});

// ---- Item 4: first-pass windows ---------------------------------------------

test("first-pass windows — an old decision counts only in the wider windows", () => {
  const recent = style({ styleId: "recent", assets: [asset("j1", "APPROVED", { reviewedAt: 0 })] });
  const old = style({
    styleId: "old",
    jobs: [{ id: "j1", status: "APPROVED", createdAt: at(-100 * DAY) }],
    assets: [asset("j1", "REJECTED", { createdAt: -100 * DAY, reviewedAt: -100 * DAY })],
  });
  const d = computeReviewerDashboard([recent, old], {}, at(0));
  const byLabel = Object.fromEntries(d.firstPass.map((w) => [w.label, w]));
  // 100 days ago is outside 1w/1m but inside 6m/1y.
  assert.equal(byLabel["1 week"].total, 1);
  assert.equal(byLabel["1 week"].clean, 1);
  assert.equal(byLabel["1 month"].total, 1);
  assert.equal(byLabel["6 months"].total, 2);
  assert.equal(byLabel["6 months"].clean, 1);
  assert.equal(byLabel["1 year"].total, 2);
});

// ---- Item 2: the reviewer filter --------------------------------------------

test("reviewer filter — scopes to orders that reviewer touched, and counts only their decisions", () => {
  const mine = style({
    styleId: "mine",
    assets: [
      asset("j1", "APPROVED", { reviewedAt: HOUR, by: "u-dilip" }),
      asset("j1", "REJECTED", { reviewedAt: 2 * HOUR, by: "u-other" }),
    ],
  });
  const theirs = style({
    styleId: "theirs",
    assets: [asset("j1", "APPROVED", { reviewedAt: HOUR, by: "u-other" })],
  });

  const all = computeReviewerDashboard([mine, theirs], {}, at(3 * HOUR));
  assert.equal(all.totalStyles, 2);
  assert.equal(all.range.reviewed, 3);

  const dilip = computeReviewerDashboard([mine, theirs], { reviewerId: "u-dilip" }, at(3 * HOUR));
  // Only the order Dilip touched is in scope…
  assert.equal(dilip.totalStyles, 1);
  // …and only his own decision on it is counted.
  assert.equal(dilip.range.reviewed, 1);
  assert.equal(dilip.range.approved, 1);
  assert.equal(dilip.range.rejected, 0);
  // The bucket stays whole-style: the other reviewer's rejection still means
  // this order is not fully approved.
  assert.equal(dilip.buckets.PARTIALLY_REVIEWED, 1);
});

// ---- Item 6: the custom date range ------------------------------------------

test("date range — only decisions inside [from, to] are counted", () => {
  const s = style({
    assets: [
      asset("j1", "APPROVED", { reviewedAt: 1 * DAY }),
      asset("j1", "REJECTED", { reviewedAt: 5 * DAY }),
      asset("j1", "APPROVED", { reviewedAt: 20 * DAY }),
    ],
  });
  const d = computeReviewerDashboard(
    [s],
    { from: at(0), to: at(10 * DAY) },
    at(30 * DAY),
  );
  assert.equal(d.range.reviewed, 2);
  assert.equal(d.range.approved, 1);
  assert.equal(d.range.rejected, 1);
  assert.equal(d.range.styles, 1);
});

test("date range — a window with no decisions reports zero but keeps the order in its bucket", () => {
  const s = style({ assets: [asset("j1", "APPROVED", { reviewedAt: 1 * DAY })] });
  const d = computeReviewerDashboard([s], { from: at(10 * DAY), to: at(20 * DAY) }, at(30 * DAY));
  assert.equal(d.range.reviewed, 0);
  assert.equal(d.range.styles, 0);
  assert.equal(d.buckets.FULLY_REVIEWED, 1);
});

// ---- Item 7: per-client -----------------------------------------------------

test("client efficiency — rolls up per customer and sorts by order count", () => {
  const netto = (id: string, s: Partial<DashStyle> = {}) =>
    style({ styleId: id, customerId: "c1", customerName: "Netto", ...s });
  const jysk = style({
    styleId: "j",
    customerId: "c2",
    customerName: "JYSK",
    assets: [asset("j1", "REJECTED", { reviewedAt: HOUR })],
  });
  const d = computeReviewerDashboard(
    [
      netto("n1", { assets: [asset("j1", "APPROVED", { reviewedAt: 2 * HOUR })] }),
      netto("n2", { assets: [asset("j1", "APPROVED", { reviewedAt: 4 * HOUR })] }),
      jysk,
    ],
    {},
    at(DAY),
  );
  assert.equal(d.clients.length, 2);
  assert.equal(d.clients[0].customerName, "Netto");
  assert.equal(d.clients[0].styles, 2);
  assert.equal(d.clients[0].fullyReviewed, 2);
  assert.equal(d.clients[0].firstPassRate, 1);
  assert.equal(d.clients[0].medianTurnaroundMs, 3 * HOUR);
  assert.equal(d.clients[1].customerName, "JYSK");
  assert.equal(d.clients[1].firstPassRate, 0);
  assert.equal(d.clients[1].medianTurnaroundMs, null);
});
