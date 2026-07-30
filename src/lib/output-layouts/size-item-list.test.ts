import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSizeItems } from "./size-scoped-text";

// ---------------------------------------------------------------------------
// Unlabelled per-size lists — the shape behind {{description:size}}. The size
// is a word INSIDE each comma-separated item, with no "SIZE:" separator, so
// the anchor-based narrowing can't see it and every repetition row printed
// the whole list.
// ---------------------------------------------------------------------------

const SIZES = ["S", "M", "L", "XL", "XXL"];
// Verbatim from CO60052's Description column — note the wrap newlines Monday
// left inside the XL and XXL entries.
const REAL =
  "Kalsonger Svart S 5-pack, Kalsonger Svart M 5-pack, Kalsonger Svart L 5-pack, " +
  "Kalsonger Svart XL\n5-pack, Kalsonger Svart XXL\n5-pack";

test("picks the row's own entry", () => {
  assert.equal(pickSizeItems(REAL, SIZES, ["M"]), "Kalsonger Svart M 5-pack");
});

test("longest label wins — XXL doesn't collide with XL or L", () => {
  assert.equal(pickSizeItems(REAL, SIZES, ["XXL"]), "Kalsonger Svart XXL 5-pack");
  assert.equal(pickSizeItems(REAL, SIZES, ["XL"]), "Kalsonger Svart XL 5-pack");
  assert.equal(pickSizeItems(REAL, SIZES, ["L"]), "Kalsonger Svart L 5-pack");
});

test("a wrap newline inside an item is normalised, not treated as a boundary", () => {
  const xl = pickSizeItems(REAL, SIZES, ["XL"]);
  assert.ok(!xl?.includes("\n"));
  assert.equal(xl, "Kalsonger Svart XL 5-pack");
});

test("the size word stays in the printed text", () => {
  assert.match(pickSizeItems(REAL, SIZES, ["S"]) ?? "", /\bS\b/);
});

test("a size letter inside a word is not a match (Svart is not S)", () => {
  // "Svart" starts with S; only the standalone "S" token may claim the item.
  assert.equal(pickSizeItems(REAL, SIZES, ["S"]), "Kalsonger Svart S 5-pack");
});

test("all sizes wanted (non-repeat / assortment row) → raw value, byte-for-byte", () => {
  // Nothing was narrowed, so the value must come back untouched — not a
  // re-joined copy with the buyer's wrap newlines collapsed.
  assert.equal(pickSizeItems(REAL, SIZES, SIZES), REAL);
});

// --- fallbacks: never blank, never guess ---------------------------------

test("no item carries a size → raw value verbatim", () => {
  const raw = "Two-pack briefs, black";
  assert.equal(pickSizeItems(raw, SIZES, ["M"]), raw);
});

test("row size absent from the list → raw value verbatim", () => {
  assert.equal(pickSizeItems(REAL, [...SIZES, "3XL"], ["3XL"]), REAL);
});

test("single item is not a list", () => {
  const raw = "Kalsonger Svart 5-pack";
  assert.equal(pickSizeItems(raw, SIZES, ["M"]), raw);
});

test("empty / undefined pass through", () => {
  assert.equal(pickSizeItems(undefined, SIZES, ["M"]), undefined);
  assert.equal(pickSizeItems("", SIZES, ["M"]), "");
  assert.equal(pickSizeItems(REAL, SIZES, []), REAL);
});

test("positional mapping is NOT attempted", () => {
  // Same item count as the size run, but no item names a size — a positional
  // guess would return "second". The house rule is to never guess.
  const raw = "first, second, third, fourth, fifth";
  assert.equal(pickSizeItems(raw, SIZES, ["M"]), raw);
});

// --- verbose customer sizes ----------------------------------------------

test("sizes with spaces / slashes match space-insensitively", () => {
  const sizes = ["86/92", "98/104", "110/116"];
  const raw = "Body Rosa 86/92, Body Rosa 98/104, Body Rosa 110/116";
  assert.equal(pickSizeItems(raw, sizes, ["98/104"]), "Body Rosa 98/104");
});

test("size label containing a space matches a wrapped occurrence", () => {
  const sizes = ["4-5 ÅR", "6-7 ÅR"];
  const raw = "HIPSTER 2PK ROSA 4-5 ÅR, HIPSTER 2PK ROSA 6-7\nÅR";
  assert.equal(pickSizeItems(raw, sizes, ["6-7 ÅR"]), "HIPSTER 2PK ROSA 6-7 ÅR");
});
