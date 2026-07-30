import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSizeRatio,
  formatSizeRatio,
  pickSizeRatioForSizes,
  pickAssortSegment,
  reduceByGcd,
} from "./size-ratio";

// Every raw value in this file is a REAL Size Ratio cell from the live
// Pre-Order board (censused 2026-07-30), so the parser is pinned to the
// shapes buyers actually type rather than to invented ones.

const SML = ["S", "M", "L", "XL", "XXL"];
const KIDS = ["98–104 cm / 3–4 år", "110–116 cm / 5–6 år", "122–128 cm / 7–8 år", "134–140 cm / 9–10 år"];

const qtys = (raw: string, sizes: readonly string[]) =>
  parseSizeRatio(raw, sizes).map((e) => e.qty);

// -----------------------------------------------------
// Positional — 64% of live values. Already a ratio: printed as typed.
// -----------------------------------------------------

test("positional comma — paired in size order, never reduced", () => {
  assert.deepEqual(qtys("1,1,2", ["S", "M", "L"]), ["1", "1", "2"]);
  assert.deepEqual(qtys("2,1,1", ["M", "L", "XL"]), ["2", "1", "1"]);
  // 2,2 across a two-size run.
  assert.deepEqual(qtys("2,2", ["38/39", "40/41"]), ["2", "2"]);
});

test("positional is NOT gcd-reduced — an even 2,2 stays 2,2", () => {
  // Reducing here would print 1,1 and misstate the buyer's pack.
  assert.deepEqual(qtys("2,2", ["S/M", "L/XL"]), ["2", "2"]);
  assert.deepEqual(qtys("4,4,3,3", KIDS), ["4", "4", "3", "3"]);
});

test("positional with spaces instead of commas", () => {
  assert.deepEqual(qtys("3 4 5 2", ["86/92", "98/104", "110/116", "122/128"]), ["3", "4", "5", "2"]);
});

test("trailing list punctuation is not a number", () => {
  assert.deepEqual(qtys("1,2,2,2,1.", SML), ["1", "2", "2", "2", "1"]);
});

test("a single number is the same ratio for every size", () => {
  assert.deepEqual(qtys("6", SML), ["6", "6", "6", "6", "6"]);
  // …but a single size takes it once, not broadcast.
  assert.deepEqual(qtys("6", ["One Size"]), ["6"]);
});

test("count mismatch — short run leaves trailing sizes blank, never invented", () => {
  // Live: 4 sizes, "4,4,3".
  assert.deepEqual(qtys("4,4,3", KIDS), ["4", "4", "3", ""]);
});

test("count mismatch — extra numbers are dropped, not folded in", () => {
  // Live: 6 sizes, 7 numbers.
  assert.deepEqual(qtys("10, 60, 150, 180, 180, 30, 10", ["XS", "S", "M", "L", "XL", "XXL"]), [
    "10",
    "60",
    "150",
    "180",
    "180",
    "30",
  ]);
});

// -----------------------------------------------------
// Labelled — total order quantities, reduced to a ratio by GCD.
// -----------------------------------------------------

test('labelled "-" — totals reduce to the smallest whole-number ratio', () => {
  assert.deepEqual(qtys("S-2000, M-4000, L-5000, XL-4800, XXL-4000", SML), [
    "10",
    "20",
    "25",
    "24",
    "20",
  ]);
});

test('labelled "-" that is ALREADY a ratio comes back untouched', () => {
  // GCD is 1 — the guarantee that makes reducing safe to apply blindly.
  assert.deepEqual(qtys("S-1, M-2, L-2, XL-2", ["S", "M", "L", "XL"]), ["1", "2", "2", "2"]);
  assert.deepEqual(qtys("S-1, M-1, L-1, XL-1", ["S", "M", "L", "XL"]), ["1", "1", "1", "1"]);
});

test("labelled totals that share no common factor simply don't reduce", () => {
  assert.deepEqual(qtys("S-51, M-79, L-100, XL-97", ["S", "M", "L", "XL"]), [
    "51",
    "79",
    "100",
    "97",
  ]);
});

test('labelled "=" — sizes containing "/" still anchor correctly', () => {
  // The "/" inside "98/104" must not be read as the separator.
  assert.deepEqual(
    qtys("98/104=115, 110/116=265, 122/128=295, 134/140=315", [
      "98/104",
      "110/116",
      "122/128",
      "134/140",
    ]),
    ["23", "53", "59", "63"],
  );
});

test('labelled "=" with a "Solid=" prefix — the prefix is not a size', () => {
  assert.deepEqual(qtys("Solid= S-200, M-400, L-400, XL-300, XXL-150", SML), [
    "4",
    "8",
    "8",
    "6",
    "3",
  ]);
});

test('labelled "/" separator', () => {
  assert.deepEqual(qtys("S/800, M/1200, L/1200, XL/1200, XXL/1000", SML), [
    "4",
    "6",
    "6",
    "6",
    "5",
  ]);
});

test("labelled — size labels whose own text contains the separator", () => {
  // "4-5ÅR" carries a "-", and the separator is also "-".
  // GCD(1040, 1040, 960) = 80.
  assert.deepEqual(qtys("4-5ÅR=1040, 6-7ÅR= 1040, 8ÅR=960", ["4-5 ÅR", "6-7 ÅR", "8 ÅR"]), [
    "13",
    "13",
    "12",
  ]);
});

test("labelled — output follows SIZE order, not the order typed", () => {
  const entries = parseSizeRatio("L-2, S-1, M-2", ["S", "M", "L"]);
  assert.deepEqual(entries.map((e) => e.size), ["S", "M", "L"]);
  assert.deepEqual(entries.map((e) => e.qty), ["1", "2", "2"]);
});

test("labelled — a size the buyer skipped stays blank", () => {
  const entries = parseSizeRatio("S-1, L-2", ["S", "M", "L"]);
  assert.deepEqual(entries.map((e) => e.qty), ["1", "", "2"]);
});

// -----------------------------------------------------
// Solid / Assort dual — the assortment table takes the ASSORT run.
// -----------------------------------------------------

test("dual value — assort numbers win", () => {
  assert.deepEqual(qtys("Solid - 60, 180, 270, 240, 90. Assort - 2,4,4,2,2", SML), [
    "2",
    "4",
    "4",
    "2",
    "2",
  ]);
  assert.deepEqual(qtys("Solid - 100,200,250,200,100. Assort - 1,2,2,2,1.", SML), [
    "1",
    "2",
    "2",
    "2",
    "1",
  ]);
  assert.deepEqual(qtys("Solid - 30, 150, 210, 210, 120. Assort - 2,2,4,4,2", SML), [
    "2",
    "2",
    "4",
    "4",
    "2",
  ]);
});

test("dual value — assort numbers are positional, so NOT reduced", () => {
  // 4,6,6,4,4 shares a factor of 2 but is already the buyer's pack ratio.
  assert.deepEqual(qtys("Solid - 80, 160, 160, 80, 80. Assort - 4,6,6,4,4", SML), [
    "4",
    "6",
    "6",
    "4",
    "4",
  ]);
});

test("pickAssortSegment slices only a true dual", () => {
  assert.equal(pickAssortSegment("Solid - 60, 180. Assort - 2,4"), "2,4");
  // Solid-only: nothing to slice, the whole value is the run.
  assert.equal(
    pickAssortSegment("Solid= S-200, M-400"),
    "Solid= S-200, M-400",
  );
  // Either order.
  assert.equal(pickAssortSegment("Assort - 1,2,1. Solid - 100,200,100"), "1,2,1");
});

test("dual value with LABELLED assort half still reduces that half", () => {
  assert.deepEqual(qtys("Solid= S-200, M-400. Assort= S-2000, M-4000", ["S", "M"]), ["1", "2"]);
});

// -----------------------------------------------------
// Fallback contract — never guess onto a customer-facing prospect.
// -----------------------------------------------------

test("prose that starts with a clean number run keeps that run", () => {
  // Live: "4,6,6,4 / 3XL-NO RATIO" — 3XL genuinely has no ratio.
  assert.deepEqual(qtys("4,6,6,4 / 3XL-NO RATIO", ["S", "M", "L", "XL", "3XL"]), [
    "4",
    "6",
    "6",
    "4",
    "",
  ]);
});

test("a run-naming prefix is stripped and the numbers behind it pair positionally", () => {
  // Carton kind, colourway, and a one-size label the buyer spelled with a
  // space the size column doesn't have.
  assert.deepEqual(qtys("Solid - 800, 1000, 1200, 1000, 1000", ["M", "L", "XL", "XXL", "3XL"]), [
    "800",
    "1000",
    "1200",
    "1000",
    "1000",
  ]);
  assert.deepEqual(qtys("Navy - 1, 2, 1", ["M", "L", "XL"]), ["1", "2", "1"]);
  assert.deepEqual(qtys("Red/White - 1, 1, 2", ["M", "L", "XL"]), ["1", "1", "2"]);
  assert.deepEqual(qtys("One size- 1000", ["ONESIZE"]), ["1000"]);
  assert.deepEqual(qtys("One size =400", ["ONESIZE"]), ["400"]);
});

test("the prefix rule cannot swallow an ambiguous or mis-typed value", () => {
  // Two colourways in one cell — which run is the assortment? Unknowable.
  assert.deepEqual(parseSizeRatio("Black-1,2,2,1 & Mix Pack-1,2,2,1", ["M", "L", "XL", "XXL"]), []);
  // Column headings with their own numbers — the prefix must be letters only.
  assert.deepEqual(
    parseSizeRatio("Col 5: 22500, Col 6: 7500, Col 8: 7500, Col 10: 7500", ["One Size"]),
    [],
  );
  // Size labels the buyer wrote with "/" where the size column uses "-", so
  // nothing anchors — and the digits in "134/140" must not qualify as a prefix.
  assert.deepEqual(
    parseSizeRatio("134/140- 312PCS, 146/152 - 444PCS, 158/164 - 312PCS", [
      "134-140",
      "146-152",
      "158-164",
    ]),
    [],
  );
});

test("unreadable / empty inputs yield no entries", () => {
  assert.deepEqual(parseSizeRatio("", SML), []);
  assert.deepEqual(parseSizeRatio(undefined, SML), []);
  assert.deepEqual(parseSizeRatio("TBC", SML), []);
  assert.deepEqual(parseSizeRatio("see attached sheet", SML), []);
  // No size run to pair against.
  assert.deepEqual(parseSizeRatio("1,2,2", []), []);
});

test("a labelled value naming none of the style's sizes is not guessed positionally", () => {
  // The names don't match this style at all → no anchors, and the value is
  // not bare numbers → nothing rather than a wrong pairing.
  assert.deepEqual(parseSizeRatio("RED-2, BLUE-4", ["S", "M"]), []);
});

// -----------------------------------------------------
// reduceByGcd
// -----------------------------------------------------

test("reduceByGcd", () => {
  assert.deepEqual(reduceByGcd([2000, 4000, 5000, 4800, 4000]), [10, 20, 25, 24, 20]);
  assert.deepEqual(reduceByGcd([1, 2, 2, 2]), [1, 2, 2, 2]);
  assert.deepEqual(reduceByGcd([115, 265, 295, 315]), [23, 53, 59, 63]);
  assert.deepEqual(reduceByGcd([]), []);
  assert.deepEqual(reduceByGcd([7]), [1]);
});

// -----------------------------------------------------
// Presentation helpers
// -----------------------------------------------------

test("formatSizeRatio drops sizes with no value", () => {
  assert.equal(formatSizeRatio(parseSizeRatio("S-1, L-2", ["S", "M", "L"])), "S: 1, L: 2");
  assert.equal(formatSizeRatio(parseSizeRatio("1,1,2", ["S", "M", "L"])), "S: 1, M: 1, L: 2");
});

test("pickSizeRatioForSizes narrows to a repetition row", () => {
  const entries = parseSizeRatio("1,1,2", ["S", "M", "L"]);
  assert.equal(pickSizeRatioForSizes(entries, ["L"]), "2");
  // Space-insensitive, like every other size match in the codebase.
  assert.equal(pickSizeRatioForSizes(parseSizeRatio("4,4,3", ["4-5 ÅR", "6-7 ÅR", "8 ÅR"]), ["4-5ÅR"]), "4");
  // A carton grouping several sizes joins them.
  assert.equal(pickSizeRatioForSizes(entries, ["S", "M"]), "1, 1");
  assert.equal(pickSizeRatioForSizes(entries, []), "");
});
