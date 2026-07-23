import { test } from "node:test";
import assert from "node:assert/strict";
import { labelHasSize, sizeRangeKey } from "./size-match";

test("sizeRangeKey — extracts the leading numeric range, separators unified", () => {
  assert.equal(sizeRangeKey("86–92 cm / 1½–2 år"), "86/92");
  assert.equal(sizeRangeKey("98/104"), "98/104");
  assert.equal(sizeRangeKey("110-116"), "110/116");
  assert.equal(sizeRangeKey("S/M"), null); // letters, not a numeric range
  assert.equal(sizeRangeKey("ONE SIZE"), null);
  assert.equal(sizeRangeKey("L"), null);
});

test("labelHasSize — bridges a verbose COOP size to the PO's bare range", () => {
  // The bug: style sizes are "86–92 cm / 1½–2 år", the PO prints "86/92".
  assert.ok(labelHasSize("PI-86/92 Pink, 86/92", "86–92 cm / 1½–2 år"));
  assert.ok(labelHasSize(".B-110/116 Blue, 110/116", "110–116 cm / 5–6 år"));
});

test("labelHasSize — a verbose size does NOT match a different range", () => {
  // 86–92 must not bleed onto the 98/104 or 122/128 variant rows.
  assert.equal(labelHasSize("PI-98/104 Pink, 98/104", "86–92 cm / 1½–2 år"), false);
  assert.equal(labelHasSize("PI-122/128 Pink, 122/128", "86–92 cm / 1½–2 år"), false);
});

test("labelHasSize — existing letter-size behaviour is unchanged", () => {
  assert.ok(labelHasSize("A-S/M Colour A Black-Black, S/M", "S/M"));
  assert.ok(labelHasSize("A-ONE SIZE Colour A, One size", "ONE SIZE"));
  // "S" must not match inside "S/M".
  assert.equal(labelHasSize("A-S/M Colour A Black-Black, S/M", "S"), false);
});

test("labelHasSize — range key respects digit boundaries", () => {
  // "86/92" must not match inside a longer number run like "186/92".
  assert.equal(labelHasSize("X-186/92 foo, 186/92", "86–92 cm"), false);
});

test("labelHasSize — a colour code containing a size letter does NOT match that size", () => {
  // Contrast PO C-PO63373 / style DS30588: the ".L" (Light Grey Melange)
  // colour code carries an "L" in every row's "<code>-<size>" prefix, so size
  // "L" used to match ALL five sizes → S, M, L, L, L, L, L, XL, XXL. Only the
  // real ".L-L … , L" row is size L; the trailing segment decides.
  assert.equal(labelHasSize("800406 .L-S Light Grey Melange, S", "L"), false);
  assert.equal(labelHasSize("800406 .L-M Light Grey Melange, M", "L"), false);
  assert.equal(labelHasSize("800406 .L-XL Light Grey Melange, XL", "L"), false);
  assert.equal(labelHasSize("800406 .L-XXL Light Grey Melange, XXL", "L"), false);
  // …but the genuine size rows still match, each to its own size.
  assert.ok(labelHasSize("800406 .L-L Light Grey Melange, L", "L"));
  assert.ok(labelHasSize("800406 .L-S Light Grey Melange, S", "S"));
  assert.ok(labelHasSize("800406 .L-XL Light Grey Melange, XL", "XL"));
  assert.ok(labelHasSize("800406 .L-XXL Light Grey Melange, XXL", "XXL"));
});
