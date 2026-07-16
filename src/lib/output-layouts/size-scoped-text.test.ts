import { test } from "node:test";
import assert from "node:assert/strict";
import { narrowSizeScopedText } from "./size-scoped-text";

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

test("empty / blank inputs pass through", () => {
  assert.equal(narrowSizeScopedText("", SIZES, ["4-5 ÅR"]), "");
  assert.equal(narrowSizeScopedText("x: 1", [], ["4-5 ÅR"]), "x: 1");
  assert.equal(narrowSizeScopedText("4-5 ÅR: 7307204", SIZES, []), "4-5 ÅR: 7307204");
});
