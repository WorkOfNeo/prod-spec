import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_APPEARANCE_KEYS,
  PLAIN_APPEARANCE,
  appearancePatch,
  applyAppearance,
  duplicateRect,
  pickAppearance,
} from "./block-appearance";
import { LayoutBlockSchema, type LayoutBlock } from "./schema";

// schema.ts is pure zod (no db/render imports), so this file needs none of
// the DATABASE_URL priming the renderer-touching suites do.

function block(patch: Partial<LayoutBlock> = {}): LayoutBlock {
  return LayoutBlockSchema.parse({
    id: "b1",
    rect: { col: 0, row: 0, colSpan: 4, rowSpan: 2 },
    lines: ["Hello"],
    ...patch,
  });
}

const GRID = { cols: 12, rows: 12 };

// ---- the key list is the contract -------------------------------------

test("appearance keys cover every block field that isn't placement or content", () => {
  // The regression this guards: a new formatting field lands on
  // LayoutBlockSchema and nobody adds it to BLOCK_APPEARANCE_KEYS, so it
  // silently stops being inherited/copied/reset. Placement and content are
  // per-block by definition and must stay OUT.
  const perBlock = new Set(["id", "anchor", "rect", "cols", "lines"]);
  const expected = Object.keys(LayoutBlockSchema.shape)
    .filter((k) => !perBlock.has(k))
    .sort();
  assert.deepEqual([...BLOCK_APPEARANCE_KEYS].sort(), expected);
});

test("the plain appearance is the one every block used to be born with", () => {
  // addRectBlock's old hardcoded literal — kept as an explicit assertion so
  // "Plain" can't drift away from what a fresh block has always looked like.
  assert.equal(PLAIN_APPEARANCE.fontPt, 9);
  assert.equal(PLAIN_APPEARANCE.lineHeight, 1.4);
  assert.equal(PLAIN_APPEARANCE.align, "left");
  assert.equal(PLAIN_APPEARANCE.valign, "top");
  assert.equal(PLAIN_APPEARANCE.bold, false);
  assert.equal(PLAIN_APPEARANCE.invert, false);
  assert.equal(PLAIN_APPEARANCE.fitWidth, false);
  assert.equal(PLAIN_APPEARANCE.fitHeight, false);
  assert.equal(PLAIN_APPEARANCE.border, undefined);
});

// ---- reading ----------------------------------------------------------

test("pickAppearance takes formatting and leaves placement and content", () => {
  const a = pickAppearance(block({ fontPt: 6, bold: true, align: "center" }));
  assert.equal(a.fontPt, 6);
  assert.equal(a.bold, true);
  assert.equal(a.align, "center");
  assert.ok(!("rect" in a), "rect must not travel with an appearance");
  assert.ok(!("lines" in a), "lines must not travel with an appearance");
  assert.ok(!("id" in a), "id must not travel with an appearance");
  assert.ok(!("cols" in a), "cols is placement, not appearance");
});

test("an absent border stays absent rather than becoming an empty object", () => {
  assert.ok(!("border" in pickAppearance(block())));
});

// ---- no aliasing ------------------------------------------------------

test("a copied border is deep-cloned, so editing one block can't move another", () => {
  const source = block({
    border: { widthMm: 0.3, color: "#000000", pad: { topMm: 1, rightMm: 1, bottomMm: 1, leftMm: 1 } },
  });
  const a = pickAppearance(source);
  const target = applyAppearance(block({ id: "b2" }), a);

  // Mutating the target's nested pad must not reach the source or the
  // clipboard — the bug this prevents is "I changed padding on one block
  // and every block I'd pasted onto changed too".
  target.border!.pad!.topMm = 9;
  assert.equal(source.border!.pad!.topMm, 1);
  assert.equal(a.border!.pad!.topMm, 1);

  // And two blocks stamped from the same clipboard must not share it.
  const t1 = applyAppearance(block({ id: "x" }), a);
  const t2 = applyAppearance(block({ id: "y" }), a);
  t1.border!.widthMm = 5;
  assert.equal(t2.border!.widthMm, 0.3);
});

// ---- stamping ---------------------------------------------------------

test("applyAppearance keeps placement, content and id", () => {
  const target = block({ id: "keep-me", rect: { col: 3, row: 7, colSpan: 2, rowSpan: 1 }, lines: ["A", "B"] });
  const out = applyAppearance(target, pickAppearance(block({ fontPt: 14, bold: true })));
  assert.equal(out.id, "keep-me");
  assert.deepEqual(out.rect, { col: 3, row: 7, colSpan: 2, rowSpan: 1 });
  assert.deepEqual(out.lines, ["A", "B"]);
  assert.equal(out.fontPt, 14);
  assert.equal(out.bold, true);
});

test("stamping a plain appearance UNSETS what the target had", () => {
  // "Make this look like that" has to remove a border too, or the target
  // ends up a hybrid of both looks.
  const bordered = block({
    border: { widthMm: 0.5, color: "#ff0000" },
    invert: true,
    invertBg: "#123456",
    fontPt: 20,
    align: "right",
  });
  const out = applyAppearance(bordered, PLAIN_APPEARANCE);
  assert.equal(out.border, undefined);
  assert.equal(out.invert, false);
  assert.equal(out.invertBg, undefined);
  assert.equal(out.fontPt, 9);
  assert.equal(out.align, "left");
  // Still a valid block afterwards.
  assert.doesNotThrow(() => LayoutBlockSchema.parse(out));
});

test("a stamped block still satisfies the block schema", () => {
  const fancy = block({
    fontPt: 7.5,
    bold: true,
    lineHeight: 1.1,
    align: "center",
    valign: "middle",
    fitWidth: true,
    invert: true,
    invertBg: "#000",
    invertText: "#fff",
    border: { widthMm: 0.3, color: "#000000", pad: { topMm: 2, rightMm: 2, bottomMm: 2, leftMm: 2 } },
  });
  const out = applyAppearance(block({ id: "b2" }), pickAppearance(fancy));
  const parsed = LayoutBlockSchema.parse(out);
  assert.deepEqual(pickAppearance(parsed), pickAppearance(fancy));
});

test("appearancePatch names every appearance key, so none is left behind", () => {
  const patch = appearancePatch(PLAIN_APPEARANCE);
  for (const k of BLOCK_APPEARANCE_KEYS) {
    assert.ok(k in patch, `${k} missing from the patch — it would keep its old value`);
  }
});

// ---- duplicate placement ----------------------------------------------

test("a duplicate lands directly below the original", () => {
  assert.deepEqual(duplicateRect({ col: 2, row: 1, colSpan: 4, rowSpan: 2 }, GRID), {
    col: 2,
    row: 3,
    colSpan: 4,
    rowSpan: 2,
  });
});

test("with no room below, the duplicate goes right", () => {
  // rowSpan 6 at row 7 → below would need rows 13..18 on a 12-row grid.
  assert.deepEqual(duplicateRect({ col: 0, row: 7, colSpan: 3, rowSpan: 6 }, GRID), {
    col: 3,
    row: 7,
    colSpan: 3,
    rowSpan: 6,
  });
});

test("with room in neither direction it lands on top, not out of bounds", () => {
  const full = { col: 0, row: 0, colSpan: 12, rowSpan: 12 };
  const out = duplicateRect(full, GRID);
  assert.deepEqual(out, full);
  assert.ok(out.row + out.rowSpan <= GRID.rows);
  assert.ok(out.col + out.colSpan <= GRID.cols);
});

test("duplicates stay inside a small non-square grid", () => {
  const grid = { cols: 5, rows: 3 };
  for (const rect of [
    { col: 0, row: 0, colSpan: 2, rowSpan: 1 },
    { col: 3, row: 2, colSpan: 2, rowSpan: 1 },
    { col: 0, row: 0, colSpan: 5, rowSpan: 3 },
  ]) {
    const out = duplicateRect(rect, grid);
    assert.ok(out.col + out.colSpan <= grid.cols, `${JSON.stringify(out)} overflows horizontally`);
    assert.ok(out.row + out.rowSpan <= grid.rows, `${JSON.stringify(out)} overflows vertically`);
  }
});
