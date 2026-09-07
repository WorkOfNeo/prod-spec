import { test } from "node:test";
import assert from "node:assert/strict";
import { isStyleInGenerationScope } from "./census";

// The vocabulary screen's PO scope. The rule is small and the consequences of
// getting it wrong are silent — a style quietly stops contributing its words —
// so each branch is pinned here rather than left to the census's DB path.
//
// Cutoff values here are invented round numbers, not the live one — this repo
// is public.

const style = (poSeq: number | null, hasPoNumber = true) => ({ poSeq, hasPoNumber });

test("with no cutoff configured, everything with a PO is in scope", () => {
  assert.equal(isStyleInGenerationScope(style(40001), null), true);
  assert.equal(isStyleInGenerationScope(style(null), null), true);
});

test("an order below the generation cutoff is out", () => {
  assert.equal(isStyleInGenerationScope(style(49999), 50000), false);
});

test("the cutoff itself is in scope, not parked", () => {
  assert.equal(isStyleInGenerationScope(style(50000), 50000), true);
  assert.equal(isStyleInGenerationScope(style(50001), 50000), true);
});

test("a PO number that didn't parse is admitted — generation admits it too", () => {
  assert.equal(isStyleInGenerationScope(style(null), 50000), true);
});

test("no PO number at all is excluded, cutoff or not", () => {
  assert.equal(isStyleInGenerationScope(style(null, false), 50000), false);
  assert.equal(isStyleInGenerationScope(style(null, false), null), false);
  // Even a parseable-looking sequence can't rescue a style with no PO cell.
  assert.equal(isStyleInGenerationScope(style(99999, false), 50000), false);
});
