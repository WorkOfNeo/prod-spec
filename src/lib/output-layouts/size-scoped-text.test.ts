import { test } from "node:test";
import assert from "node:assert/strict";
import { narrowSizeScopedText, hasSizeAnchors } from "./size-scoped-text";

// Real-world shapes: the Customer Item No / Description columns filled as
// per-size lists keyed by the style's size labels ("4-5 ÅR: 7307204, …").

const SIZES = ["4-5 ÅR", "6-7 ÅR", "8 ÅR"];

test("per-size item numbers → each row gets its own entry", () => {
  const raw = "4-5 ÅR: 7307204, \n6-7 ÅR: 7307214, \n8 ÅR:7307213";
  assert.equal(narrowSizeScopedText(raw, SIZES, ["4-5 ÅR"]), "7307204");
  assert.equal(narrowSizeScopedText(raw, SIZES, ["6-7 ÅR"]), "7307214");
  // "8 ÅR:7307213" — no space after the colon.
  assert.equal(narrowSizeScopedText(raw, SIZES, ["8 ÅR"]), "7307213");
});

test("description values containing the size text (no colon) don't split", () => {
  const raw =
    "4-5 ÅR: HIPSTER 2PK HELLO KIT ROSA 4-5 ÅR, 6-7 ÅR: HIPSTER 2PK HELLO KIT ROSA 6-7 ÅR, 8 ÅR: HIPSTER 2PK HELLO KIT ROSA 8 ÅR,";
  assert.equal(
    narrowSizeScopedText(raw, SIZES, ["4-5 ÅR"]),
    "HIPSTER 2PK HELLO KIT ROSA 4-5 ÅR",
  );
  // Trailing list comma stripped on the last entry.
  assert.equal(narrowSizeScopedText(raw, SIZES, ["8 ÅR"]), "HIPSTER 2PK HELLO KIT ROSA 8 ÅR");
});

test("label matching is space- and case-insensitive", () => {
  const raw = "4-5ÅR: 7307204, 6-7 år: 7307214";
  assert.equal(narrowSizeScopedText(raw, SIZES, ["4-5 ÅR"]), "7307204");
  assert.equal(narrowSizeScopedText(raw, SIZES, ["6-7 ÅR"]), "7307214");
});

test("no size anchors → raw value stands (plain single-value field)", () => {
  assert.equal(narrowSizeScopedText("223609", SIZES, ["4-5 ÅR"]), "223609");
  // Colons that don't belong to a known size are not anchors.
  assert.equal(
    narrowSizeScopedText("Note: keep flat", SIZES, ["4-5 ÅR"]),
    "Note: keep flat",
  );
});

test("anchors exist but none match the row's size → raw value stands", () => {
  const raw = "4-5 ÅR: 7307204, 6-7 ÅR: 7307214";
  assert.equal(narrowSizeScopedText(raw, ["4-5 ÅR", "6-7 ÅR", "8 ÅR"], ["8 ÅR"]), raw);
});

test("carton grouping several sizes joins their entries", () => {
  const raw = "4-5 ÅR: 7307204, 6-7 ÅR: 7307214, 8 ÅR: 7307213";
  assert.equal(
    narrowSizeScopedText(raw, SIZES, ["4-5 ÅR", "6-7 ÅR"]),
    "7307204, 7307214",
  );
});

test("idempotent — a narrowed value passes through unchanged", () => {
  const once = narrowSizeScopedText(
    "4-5 ÅR: HIPSTER 2PK ROSA 4-5 ÅR, 6-7 ÅR: HIPSTER 2PK ROSA 6-7 ÅR",
    SIZES,
    ["4-5 ÅR"],
  );
  assert.equal(once, "HIPSTER 2PK ROSA 4-5 ÅR");
  assert.equal(narrowSizeScopedText(once, SIZES, ["4-5 ÅR"]), once);
});

test('"=" separator — carton-qty lists narrow per size', () => {
  const raw = "4-5ÅR=1040, 6-7ÅR=1050, 8ÅR=1030";
  const seps = [":", "="];
  assert.equal(narrowSizeScopedText(raw, SIZES, ["4-5 ÅR"], seps), "1040");
  assert.equal(narrowSizeScopedText(raw, SIZES, ["8 ÅR"], seps), "1030");
  // Carton grouping joins qty entries too.
  assert.equal(narrowSizeScopedText(raw, SIZES, ["4-5 ÅR", "6-7 ÅR"], seps), "1040, 1050");
  // A plain numeric qty has no anchors → verbatim.
  assert.equal(narrowSizeScopedText("1040", SIZES, ["4-5 ÅR"], seps), "1040");
});

test('"=" separator — real-world shapes', () => {
  const seps = [":", "="];
  // No spaces around commas or the "=" (live Size Ratio format).
  const raw = "2-3Y=150PCS,4-5Y=200PCS,6-7Y=240PCS,8Y=200PCS";
  const sizes = ["2-3Y", "4-5Y", "6-7Y", "8Y"];
  assert.equal(narrowSizeScopedText(raw, sizes, ["4-5Y"], seps), "200PCS");
  assert.equal(narrowSizeScopedText(raw, sizes, ["8Y"], seps), "200PCS");
  // Composition-style notes: the text before "=" is not a size label, so
  // there's no anchor and the value passes verbatim.
  const note = "EV90000(White)+EV90000(Black)=15";
  assert.equal(narrowSizeScopedText(note, sizes, ["4-5Y"], seps), note);
});

test('default separators exclude "=" — item-no/description behavior unchanged', () => {
  const raw = "4-5ÅR=1040, 6-7ÅR=1050";
  assert.equal(narrowSizeScopedText(raw, SIZES, ["4-5 ÅR"]), raw);
});

test("empty / blank inputs pass through", () => {
  assert.equal(narrowSizeScopedText("", SIZES, ["4-5 ÅR"]), "");
  assert.equal(narrowSizeScopedText("x: 1", [], ["4-5 ÅR"]), "x: 1");
  assert.equal(narrowSizeScopedText("4-5 ÅR: 7307204", SIZES, []), "4-5 ÅR: 7307204");
});

// A per-size list wrapped in a heading ("Carton: …, Product: S: 1, M: 2").
// The FIRST size sits behind the heading with no comma before it, so the
// candidate label read as "Product: S", matched nothing, and the whole raw
// cell — carton number included — fell through onto that size's label.
// Every later size is preceded by a comma and always worked.
test("a size behind a heading still anchors (first-size regression)", () => {
  const raw = "Carton: 933977900, Product: S: 933977001, M: 933977002, L: 933977003";
  const sizes = ["S", "M", "L"];
  assert.equal(narrowSizeScopedText(raw, sizes, ["S"]), "933977001");
  assert.equal(narrowSizeScopedText(raw, sizes, ["M"]), "933977002");
  assert.equal(narrowSizeScopedText(raw, sizes, ["L"]), "933977003");
});

test("a heading that is not a size label still opens no anchor", () => {
  // "Carton" and "Product" must never be treated as sizes themselves.
  const raw = "Carton: 933977900, Product: S: 933977001";
  assert.equal(narrowSizeScopedText(raw, ["S"], ["S"]), "933977001");
});

test("hasSizeAnchors separates a labelled list from a plain one", () => {
  assert.equal(hasSizeAnchors("S: 1, M: 2", ["S", "M"]), true);
  assert.equal(hasSizeAnchors("Carton: 9, Product: S: 1", ["S", "M"]), true);
  assert.equal(hasSizeAnchors("924126001, 924126002", ["S", "M"]), false);
  assert.equal(hasSizeAnchors("Carton: 933985001", ["35/38"]), false);
  assert.equal(hasSizeAnchors("", ["S"]), false);
  assert.equal(hasSizeAnchors("S: 1", []), false);
});
