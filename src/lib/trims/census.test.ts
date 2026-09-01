import { test } from "node:test";
import assert from "node:assert/strict";
import { isStyleInGenerationScope } from "./census";

// The vocabulary screen's PO scope. The rule is small and the consequences of
// getting it wrong are silent — a style quietly stops contributing its words —
// so each branch is pinned here rather than left to the census's DB path.

const style = (poSeq: number | null, hasPoNumber = true) => ({ poSeq, hasPoNumber });

test("with no cutoff configured, everything with a PO is in scope", () => {
  assert.equal(isStyleInGenerationScope(style(61278), null), true);
  assert.equal(isStyleInGenerationScope(style(null), null), true);
});

test("an order below the generation cutoff is out", () => {
  assert.equal(isStyleInGenerationScope(style(63319), 63320), false);
});

test("the cutoff itself is in scope, not parked", () => {
  assert.equal(isStyleInGenerationScope(style(63320), 63320), true);
  assert.equal(isStyleInGenerationScope(style(63321), 63320), true);
});

test("a PO number that didn't parse is admitted — generation admits it too", () => {
  assert.equal(isStyleInGenerationScope(style(null), 63320), true);
});

test("no PO number at all is excluded, cutoff or not", () => {
  assert.equal(isStyleInGenerationScope(style(null, false), 63320), false);
  assert.equal(isStyleInGenerationScope(style(null, false), null), false);
  // Even a parseable-looking sequence can't rescue a style with no PO cell.
  assert.equal(isStyleInGenerationScope(style(99999, false), 63320), false);
});
