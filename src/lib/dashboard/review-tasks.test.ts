import { test, before } from "node:test";
import assert from "node:assert/strict";

// review-tasks.ts imports @/lib/db, whose client construction needs
// DATABASE_URL at import time. Nothing here queries — the pg pool is lazy.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let latestPerStyle: typeof import("./review-tasks").latestPerStyle;
let bucketOf: typeof import("./review-tasks").bucketOf;

before(async () => {
  ({ latestPerStyle, bucketOf } = await import("./review-tasks"));
});

type Status = "PENDING_REVIEW" | "APPROVED" | "REJECTED";

// A job as the OLD awaiting-review query loaded it for the badge: the whole
// style, every asset column, reviewer emails. The badge now loads only the
// slim projection below; bucketing both must give the same answer.
function fullJob(
  id: string,
  styleId: string,
  opts: { claimedBy?: string; assets?: Array<[Status, string?]> } = {},
) {
  return {
    id,
    styleId,
    status: "AWAITING_REVIEW",
    createdAt: new Date(),
    reviewClaimedById: opts.claimedBy ?? null,
    reviewClaimedAt: opts.claimedBy ? new Date() : null,
    reviewClaimedBy: opts.claimedBy ? { email: `${opts.claimedBy}@x` } : null,
    style: { id: styleId, name: styleId, rawData: { big: true }, customer: { name: "C", config: {} } },
    assets: (opts.assets ?? []).map(([reviewStatus, reviewedById], i) => ({
      variantKey: `v${i}`,
      docType: "CARE_LABEL",
      displayName: null,
      reviewStatus,
      reviewedById: reviewedById ?? null,
      reviewedAt: reviewedById ? new Date() : null,
      placeholderCount: 0,
      reviewedBy: reviewedById ? { email: `${reviewedById}@x` } : null,
    })),
  };
}

// Exactly the columns queryAwaitingReviewHeads selects.
const slim = (j: ReturnType<typeof fullJob>) => ({
  id: j.id,
  styleId: j.styleId,
  reviewClaimedById: j.reviewClaimedById,
  assets: j.assets.map((a) => ({ reviewStatus: a.reviewStatus, reviewedById: a.reviewedById })),
});

// Newest first, as the query orders them. Mirrors the shapes the dashboard
// meets: claims, partial decisions, stranded older jobs, empty jobs.
const FIXTURE = [
  fullJob("j1", "s-claimed-by-me", { claimedBy: "me", assets: [["PENDING_REVIEW"]] }),
  fullJob("j2", "s-decided-by-me", { assets: [["APPROVED", "me"], ["PENDING_REVIEW"]] }),
  fullJob("j3", "s-claimed-other-decided-me", {
    claimedBy: "other",
    assets: [["REJECTED", "me"], ["PENDING_REVIEW"]],
  }),
  fullJob("j4", "s-decided-by-other", { assets: [["APPROVED", "other"], ["PENDING_REVIEW"]] }),
  fullJob("j5", "s-claimed-by-other", { claimedBy: "other", assets: [["PENDING_REVIEW"]] }),
  fullJob("j6", "s-untouched", { assets: [["PENDING_REVIEW"], ["PENDING_REVIEW"]] }),
  // Newest job untouched; an older stranded job of the same style was mine —
  // the newest wins, so the style is untouched.
  fullJob("j7", "s-rerun", { assets: [["PENDING_REVIEW"]] }),
  fullJob("j8", "s-rerun", { claimedBy: "me", assets: [["APPROVED", "me"]] }),
  // Newest job rendered nothing: the style drops out entirely (no fallback to
  // the older job).
  fullJob("j9", "s-empty-newest", {}),
  fullJob("j10", "s-empty-newest", { claimedBy: "me", assets: [["PENDING_REVIEW"]] }),
  // Every document decided, still AWAITING_REVIEW (publish retry) — mine.
  fullJob("j11", "s-all-approved", { assets: [["APPROVED", "me"], ["APPROVED", "me"]] }),
];

const bucketsFor = <J extends Parameters<typeof bucketOf>[0] & { id: string }>(
  jobs: J[],
  userId: string,
) => latestPerStyle(jobs).map((j) => [j.id, bucketOf(j, userId)] as const);

test("latestPerStyle — newest job per style, empty newest jobs dropped", () => {
  assert.deepEqual(
    latestPerStyle(FIXTURE).map((j) => j.id),
    ["j1", "j2", "j3", "j4", "j5", "j6", "j7", "j11"],
  );
});

test("bucketOf — expected buckets for one reviewer", () => {
  assert.deepEqual(bucketsFor(FIXTURE, "me"), [
    ["j1", "mine"],
    ["j2", "mine"],
    ["j3", "mine"],
    ["j4", "others"],
    ["j5", "others"],
    ["j6", "untouched"],
    ["j7", "untouched"],
    ["j11", "mine"],
  ]);
});

test("slim badge projection buckets exactly like the full card rows", () => {
  const slimJobs = FIXTURE.map(slim);
  for (const user of ["me", "other", "nobody"]) {
    assert.deepEqual(bucketsFor(slimJobs, user), bucketsFor(FIXTURE, user), user);
  }
  // The badge counts for "other": claimed/decided by them → mine, by me → others.
  const counts = { mine: 0, others: 0, untouched: 0 };
  for (const [, b] of bucketsFor(slimJobs, "other")) counts[b]++;
  assert.deepEqual(counts, { mine: 3, others: 3, untouched: 2 });
});
