import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBatchSize, EAN_BATCH } from "./batch-size";

// Target budget 150s, cap [5, 40], fallback 3s/style.

test("computeBatchSize — no history uses the fallback per-style cost", () => {
  // 150_000 / 3_000 = 50 → clamped to max 40.
  assert.equal(computeBatchSize([]), EAN_BATCH.max);
});

test("computeBatchSize — sizes to the target budget at the observed cost", () => {
  // ~3s/style → 150_000 / 3_000 = 50 → clamp 40.
  assert.equal(computeBatchSize([3_000, 3_000, 3_000]), 40);
  // ~5s/style → 150_000 / 5_000 = 30 (within range, not clamped).
  assert.equal(computeBatchSize([5_000, 5_000]), 30);
  // ~10s/style → 15 styles.
  assert.equal(computeBatchSize([10_000]), 15);
});

test("computeBatchSize — clamps to [min, max]", () => {
  // Very slow scrapes (30s/style) → 5 → floored at min.
  assert.equal(computeBatchSize([30_000, 30_000]), EAN_BATCH.min);
  // Implausibly fast → floored per-style at 500ms → 300, clamped to max.
  assert.equal(computeBatchSize([10, 20, 30]), EAN_BATCH.max);
});

test("computeBatchSize — even count picks the upper of the two middles", () => {
  // [2s, 4s] → upper median = 4s → 150000/4000 = 37 (a lower-median 2s would
  // give 40). The conservative lean → a slightly smaller, safer batch.
  assert.equal(computeBatchSize([2_000, 4_000]), 37);
});

test("computeBatchSize — ignores non-finite / non-positive samples", () => {
  assert.equal(computeBatchSize([NaN, 0, -5, 3_000]), 40); // only 3_000 counts
  assert.equal(computeBatchSize([Infinity]), EAN_BATCH.max); // no valid → fallback
});
