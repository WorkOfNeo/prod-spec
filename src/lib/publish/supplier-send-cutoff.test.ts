import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeliverablePo, deliverablePoWhere, belowCutoffNote } from "./supplier-send-cutoff";

// The cutoff rule that the 2026-08-13 mass send exposed: enqueue, send and push
// must all read it the same way. These pin the three answers that matter — at
// the boundary, below it, and with no PO to place on the timeline at all.

test("no cutoff configured ⇒ everything is deliverable", () => {
  assert.equal(isDeliverablePo(61331, null), true);
  assert.equal(isDeliverablePo(null, null), true);
  assert.deepEqual(deliverablePoWhere(null), {});
});

test("the cutoff is inclusive at its own PO", () => {
  assert.equal(isDeliverablePo(63320, 63320), true);
  assert.equal(isDeliverablePo(63321, 63320), true);
});

test("a PO below the cutoff is not deliverable", () => {
  // The oldest PO that actually went out on 2026-08-13.
  assert.equal(isDeliverablePo(61331, 63320), false);
  assert.equal(isDeliverablePo(63319, 63320), false);
});

test("an unparseable PO is not deliverable once a cutoff exists", () => {
  assert.equal(isDeliverablePo(null, 63320), false);
  assert.equal(isDeliverablePo(undefined, 63320), false);
});

test("the where fragment matches the predicate, NULLs included", () => {
  // `gte` never matches NULL in SQL, which is what makes the two agree without
  // the query needing an explicit `poSeq: { not: null }`.
  assert.deepEqual(deliverablePoWhere(63320), { poSeq: { gte: 63320 } });
});

test("the note names the reason, not just the verdict", () => {
  assert.match(belowCutoffNote(61331, 63320), /61331/);
  assert.match(belowCutoffNote(61331, 63320), /63320/);
  assert.match(belowCutoffNote(null, 63320), /no parseable PO/);
});
