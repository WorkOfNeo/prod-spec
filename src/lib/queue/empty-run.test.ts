import { test } from "node:test";
import assert from "node:assert/strict";
import { settleEmptyFullRun } from "@/lib/queue/empty-run";

// A FULL run that rendered nothing. Defaults describe the field case below;
// each test overrides only what it is about.
const run = (over: Partial<Parameters<typeof settleEmptyFullRun>[0]> = {}) =>
  settleEmptyFullRun({
    generated: 0,
    scoped: 0,
    approvedSkips: 0,
    missingFieldSkips: 0,
    skippedForStyle: 0,
    reachedLoop: 0,
    ...over,
  });

test("approved + the rest ignored/excluded rebuilds the cover (the 2026-11-17 field case)", () => {
  // 3 outputs approved and carried forward; the 3 left were a rule hit, a rule
  // hit and a reviewer's Ignore. This used to end as "needs-none", which skips
  // the cover — so the cover kept the ignored output on its list.
  assert.equal(run({ approvedSkips: 3, skippedForStyle: 3, reachedLoop: 3 }), "fully-approved");
});

test("pure approval still rebuilds the cover — unchanged", () => {
  assert.equal(run({ approvedSkips: 4 }), "fully-approved");
});

test("nothing approved and everything skipped: the style needs no documents — unchanged", () => {
  assert.equal(run({ skippedForStyle: 2, reachedLoop: 2 }), "needs-none");
});

test("an output still waiting on Monday fields never settles APPROVED", () => {
  // It has to keep surfacing as "awaiting data", whatever else was skipped.
  // "needs-none" used to ignore this count and would have hidden it.
  assert.equal(run({ missingFieldSkips: 1, skippedForStyle: 2, reachedLoop: 2 }), null);
  assert.equal(run({ missingFieldSkips: 1, approvedSkips: 2 }), null);
});

test("a scoped run or a run that rendered something takes neither ending", () => {
  assert.equal(run({ scoped: 1, approvedSkips: 1 }), null);
  assert.equal(run({ scoped: 1, skippedForStyle: 1, reachedLoop: 1 }), null);
  assert.equal(run({ generated: 1, approvedSkips: 1 }), null);
});

test("only some outputs skipped and nothing approved is not 'needs none'", () => {
  // The rest reached the loop but neither rendered nor were skipped (unknown
  // variant) — a misconfiguration the runner reports as NO_OUTPUTS.
  assert.equal(run({ skippedForStyle: 1, reachedLoop: 2 }), null);
  assert.equal(run(), null);
});
