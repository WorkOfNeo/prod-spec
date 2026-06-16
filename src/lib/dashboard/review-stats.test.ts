import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeReviewStats,
  formatDuration,
  median,
  percentile,
  avg,
  type StatsOutputInput,
} from "./review-stats";
import { canReview } from "../roles";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function output(p: {
  styleId?: string;
  styleName?: string;
  customerName?: string;
  outputName: string;
  reviewStatus: "APPROVED" | "REJECTED";
  createdAt: string;
  reviewedAt: string;
  by: { id: string; email: string; name: string } | null;
}): StatsOutputInput {
  return {
    styleId: p.styleId ?? "style-1",
    styleName: p.styleName ?? "Tee Crew",
    customerName: p.customerName ?? "2BIZ",
    outputName: p.outputName,
    reviewStatus: p.reviewStatus,
    createdAt: new Date(p.createdAt),
    reviewedAt: new Date(p.reviewedAt),
    reviewerId: p.by?.id ?? null,
    reviewerEmail: p.by?.email ?? null,
    reviewerName: p.by?.name ?? null,
  };
}

const ALICE = { id: "u1", email: "alice@x.com", name: "Alice" };
const BOB = { id: "u2", email: "bob@x.com", name: "Bob" };

// Carton: generated 11:00 → approved 13:00 (2h), by Alice.
const carton = output({
  outputName: "Carton sticker",
  reviewStatus: "APPROVED",
  createdAt: "2026-06-01T11:00:00Z",
  reviewedAt: "2026-06-01T13:00:00Z",
  by: ALICE,
});
// Hangtag: generated 11:30 → approved 12:00 (30m), by Alice.
const hangtag = output({
  outputName: "Hangtag",
  reviewStatus: "APPROVED",
  createdAt: "2026-06-01T11:30:00Z",
  reviewedAt: "2026-06-01T12:00:00Z",
  by: ALICE,
});
// Care label: generated 09:00 → rejected 09:30 (30m), by Bob, other style.
const care = output({
  styleId: "style-2",
  styleName: "Pullover",
  customerName: "Netto",
  outputName: "Care label",
  reviewStatus: "REJECTED",
  createdAt: "2026-06-01T09:00:00Z",
  reviewedAt: "2026-06-01T09:30:00Z",
  by: BOB,
});

test("formatDuration renders compact, rounded spans", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(-5), "0s");
  assert.equal(formatDuration(30_000), "30s");
  assert.equal(formatDuration(45 * MIN), "45m");
  assert.equal(formatDuration(2 * HOUR), "2h");
  assert.equal(formatDuration(2 * HOUR + 30 * MIN), "2h 30m");
  assert.equal(formatDuration(DAY), "1d");
  assert.equal(formatDuration(2 * DAY + 4 * HOUR), "2d 4h");
});

test("median / avg / percentile handle empties and parity", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 3); // (2+3)/2 rounded
  assert.equal(avg([]), null);
  assert.equal(avg([2, 4]), 3);
  assert.equal(percentile([], 90), null);
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90), 90);
});

test("canReview gates to ADMIN and REVIEWER only", () => {
  assert.equal(canReview("ADMIN"), true);
  assert.equal(canReview("REVIEWER"), true);
  assert.equal(canReview(null), false);
  assert.equal(canReview("SUPPLIER" as never), false);
});

test("computeReviewStats aggregates per-output durations and outcomes", () => {
  const s = computeReviewStats([carton, hangtag, care]);

  assert.equal(s.totalOutputs, 3);
  // durations: 2h, 30m, 30m → median 30m, avg 1h, p90 2h
  assert.equal(s.medianDurationMs, 30 * MIN);
  assert.equal(s.avgDurationMs, HOUR);
  assert.equal(s.p90DurationMs, 2 * HOUR);
  assert.equal(s.longest?.outputName, "Carton sticker");

  assert.equal(s.totalApproved, 2);
  assert.equal(s.totalRejected, 1);
  assert.equal(s.approvalRate, 2 / 3);

  // Newest decision first.
  assert.equal(s.recent[0].outputName, "Carton sticker");
  assert.equal(s.recent[0].durationMs, 2 * HOUR);
});

test("computeReviewStats attributes per reviewer", () => {
  const s = computeReviewStats([carton, hangtag, care]);

  // Alice has 2 outputs → sorts first.
  assert.equal(s.reviewers[0].userId, ALICE.id);
  assert.equal(s.reviewers[0].outputsReviewed, 2);
  assert.equal(s.reviewers[0].approved, 2);
  assert.equal(s.reviewers[0].rejected, 0);
  assert.equal(s.reviewers[0].approvalRate, 1);
  assert.equal(s.reviewers[0].avgDurationMs, (2 * HOUR + 30 * MIN) / 2);

  const bob = s.reviewers.find((r) => r.userId === BOB.id)!;
  assert.equal(bob.outputsReviewed, 1);
  assert.equal(bob.approved, 0);
  assert.equal(bob.rejected, 1);
  assert.equal(bob.approvalRate, 0);
  assert.equal(bob.avgDurationMs, 30 * MIN);
});

test("computeReviewStats clamps negative durations and is empty-safe", () => {
  // A weird row where reviewedAt precedes createdAt clamps to 0, never negative.
  const weird = output({
    outputName: "Odd",
    reviewStatus: "APPROVED",
    createdAt: "2026-06-01T10:00:00Z",
    reviewedAt: "2026-06-01T09:00:00Z",
    by: ALICE,
  });
  assert.equal(computeReviewStats([weird]).recent[0].durationMs, 0);

  const s = computeReviewStats([]);
  assert.equal(s.totalOutputs, 0);
  assert.equal(s.avgDurationMs, null);
  assert.equal(s.medianDurationMs, null);
  assert.equal(s.approvalRate, null);
  assert.equal(s.reviewers.length, 0);
  assert.equal(s.recent.length, 0);
});
