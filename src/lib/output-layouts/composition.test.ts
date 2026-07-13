import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCompositionLines } from "./composition";

// Every input below is a REAL composition string observed across the live
// styles (surveyed 2026-07-13), so the parser is pinned to production data,
// not invented shapes. The label word is treated as a translated token — the
// split anchors on "<word>:", never on the English words Outer/Inner.

test("splits the canonical Outer/Inner style onto two lines (IL97336)", () => {
  assert.equal(
    formatCompositionLines("Outer: 91% Polyester 9% Elastane Inner: 100% Polyester"),
    "Outer: 91% Polyester 9% Elastane\nInner: 100% Polyester",
  );
});

test("does NOT mis-split a value word adjacent to the next label", () => {
  // The dangerous case: "Elastane Inner:" must break only before "Inner",
  // never turning "Elastane" into part of a label.
  const out = formatCompositionLines("Outer: 91% Polyester 9% Elastane Inner: 100% Polyester");
  assert.ok(out.startsWith("Outer: 91% Polyester 9% Elastane\n"));
  assert.equal(out.split("\n").length, 2);
});

test("splits space-separated parts with no comma (Top/Skirt)", () => {
  assert.equal(
    formatCompositionLines("Top: 100% Cotton Skirt: 100% Polyester"),
    "Top: 100% Cotton\nSkirt: 100% Polyester",
  );
});

test("splits comma-separated labelled parts and trims the stray comma", () => {
  assert.equal(
    formatCompositionLines("Lining: 100% Cotton, Skirt: 100% Polyester"),
    "Lining: 100% Cotton\nSkirt: 100% Polyester",
  );
  assert.equal(
    formatCompositionLines("Outer: 100% Polyester,  Lining: 100% polyester mesh"),
    "Outer: 100% Polyester\nLining: 100% polyester mesh",
  );
});

test("splits an UNLABELLED first part from a labelled second part", () => {
  assert.equal(
    formatCompositionLines("95% Polyester 5% Elastane, Inner: 100% Polyester"),
    "95% Polyester 5% Elastane\nInner: 100% Polyester",
  );
  assert.equal(
    formatCompositionLines("100% Cotton, Tulle: 100% Polyester"),
    "100% Cotton\nTulle: 100% Polyester",
  );
});

test("splits a part whose value has no percentage (Sheep Leather)", () => {
  // The first part carries a label but no "%", so the break relies on the
  // presence of an earlier "<word>: <value>" part rather than a percentage.
  assert.equal(
    formatCompositionLines("Outer: Sheep Leather and Polyester. Inner: 100% Polyester"),
    "Outer: Sheep Leather and Polyester\nInner: 100% Polyester",
  );
});

test("splits a non-percentage second value (Upper/Sole)", () => {
  assert.equal(
    formatCompositionLines("Upper: 100% Polyester, Sole: TPR with memory foam"),
    "Upper: 100% Polyester\nSole: TPR with memory foam",
  );
});

test("handles period-separated / nested parts (Hats/Gloves)", () => {
  assert.equal(
    formatCompositionLines(
      "Hats: Outside: 100% Polyester. Inside : 100% Acrylic. Gloves: 84% Acrylic, 15% Polyester, 1% Elastane",
    ),
    "Hats: Outside: 100% Polyester\nInside : 100% Acrylic\nGloves: 84% Acrylic, 15% Polyester, 1% Elastane",
  );
});

test("leaves a SINGLE composition untouched (no labels)", () => {
  for (const s of [
    "95% Cotton, 5% Elastane",
    "70% Polyester 21% Polyamide 8% Wool 1% Elastane",
    "100% Organic Cotton",
  ]) {
    assert.equal(formatCompositionLines(s), s);
  }
});

test("leaves a single labelled composition on one line", () => {
  for (const s of ["Outer: 100% Cotton", "Fur: 100% Polyester"]) {
    assert.equal(formatCompositionLines(s), s);
  }
});

test("leaves a long DESCRIPTIVE single-colon label intact (German)", () => {
  // "Kapuze, Kordel, … und Saum:" is one descriptive label for one part —
  // it must NOT break before "Saum" (no earlier part, no percentage before
  // the colon).
  const de = "Kapuze, Kordel, Rippbündchen an Ärmeln und Saum:  50% Baumwolle 50% Polyester";
  assert.equal(formatCompositionLines(de), de);
});

test("leaves a genuine multi-word label (single part) on one line", () => {
  for (const s of [
    "Fleece Lining : 100% Polyester",
    "Top + Inner skirt : 100% Cotton,1 layer of tulle",
  ]) {
    assert.equal(formatCompositionLines(s), s);
  }
});

test("is idempotent — already-split input re-splits to itself", () => {
  const inputs = [
    "Outer: 91% Polyester 9% Elastane Inner: 100% Polyester",
    "52% Polyester 48% Sheepskin\nLining: 100% Polyester",
    "Top: 100% Cotton Skirt: 100% Polyester",
  ];
  for (const s of inputs) {
    const once = formatCompositionLines(s);
    assert.equal(formatCompositionLines(once), once);
  }
});

test("empty / colon-free input is returned unchanged", () => {
  assert.equal(formatCompositionLines(""), "");
  assert.equal(formatCompositionLines("100% Cotton"), "100% Cotton");
});
