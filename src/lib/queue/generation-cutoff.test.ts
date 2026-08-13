import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isBelowGenerationCutoff,
  inGenerationScopeWhere,
  partitionByGenerationCutoff,
} from "./generation-cutoff";
import { isDeliverablePo } from "@/lib/publish/supplier-send-cutoff";

test("no cutoff configured ⇒ nothing is parked", () => {
  assert.equal(isBelowGenerationCutoff(61278, null), false);
  assert.equal(isBelowGenerationCutoff(null, null), false);
  assert.deepEqual(inGenerationScopeWhere(null), {});
});

test("the cutoff is inclusive at its own PO", () => {
  assert.equal(isBelowGenerationCutoff(63320, 63320), false);
  assert.equal(isBelowGenerationCutoff(63321, 63320), false);
  assert.equal(isBelowGenerationCutoff(63319, 63320), true);
  // The oldest style on the Tokmanni spec that prompted this.
  assert.equal(isBelowGenerationCutoff(61278, 63320), true);
});

test("a null poSeq stays IN scope for generation — the opposite of supplier send", () => {
  // This is the whole reason the two cutoffs are separate functions. An
  // unparseable PO must keep generating, but must never reach a supplier.
  assert.equal(isBelowGenerationCutoff(null, 63320), false);
  assert.equal(isDeliverablePo(null, 63320), false);
});

test("the where fragment mirrors the sweep's own clause", () => {
  assert.deepEqual(inGenerationScopeWhere(63320), {
    OR: [{ poSeq: { gte: 63320 } }, { poSeq: null }],
  });
});

test("partition splits rows the way the bulk lanes report them", () => {
  const rows = [
    { id: "a", poSeq: 63400 },
    { id: "b", poSeq: 61278 },
    { id: "c", poSeq: null },
    { id: "d", poSeq: 63320 },
  ];
  const { inScope, belowCutoff } = partitionByGenerationCutoff(rows, 63320);
  assert.deepEqual(inScope.map((r) => r.id), ["a", "c", "d"]);
  assert.deepEqual(belowCutoff.map((r) => r.id), ["b"]);
});

test("partition with no cutoff runs everything", () => {
  const rows = [{ id: "a", poSeq: 1 }, { id: "b", poSeq: null }];
  const { inScope, belowCutoff } = partitionByGenerationCutoff(rows, null);
  assert.equal(inScope.length, 2);
  assert.equal(belowCutoff.length, 0);
});
