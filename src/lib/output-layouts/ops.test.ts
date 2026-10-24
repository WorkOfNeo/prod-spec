import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyLayoutOps,
  describeLayoutChanges,
  validateLayoutLine,
  type LayoutOp,
} from "./ops";
import { LayoutDefSchema, type LayoutDef } from "./schema";

// The op language a change-request agent edits layouts through. Everything
// here is synthetic: a 50×60 mm solid polybag sticker on a 1 mm grid
// (50 × 60 cells), so rects read directly as millimetres.

const QTY_LINE = '{{if polybagQty != ""}}{{polybagQty}} PCS{{endif}}';

function sticker(): LayoutDef {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "Sticker",
        widthMm: 50,
        heightMm: 60,
        gridCols: 50,
        gridRows: 60,
        blocks: [
          { id: "b-style", rect: { col: 2, row: 2, colSpan: 46, rowSpan: 6 }, fontPt: 9, lines: ["{{styleNumber}}"] },
          { id: "b-size", rect: { col: 2, row: 10, colSpan: 46, rowSpan: 6 }, fontPt: 9, lines: ["SIZE: {{size}}"] },
          { id: "b-ean", rect: { col: 2, row: 18, colSpan: 46, rowSpan: 20 }, lines: ["{{barcode:ean13}}"] },
          {
            id: "b-colour",
            rect: { col: 2, row: 48, colSpan: 46, rowSpan: 7 },
            fontPt: 6.5,
            lines: ["COLOUR: {{colourName}}", "MADE IN BANGLADESH"],
          },
        ],
      },
    ],
  });
}

const snapshot = (v: unknown) => JSON.stringify(v);
const blockOf = (def: LayoutDef, id: string, page = 0) => def.pages[page].blocks.find((b) => b.id === id);

// ---- the reference case (design §5.2) -----------------------------------

test("reference: the polybag quantity block lands at col 7, row 42 (27×4) cleanly", () => {
  const before = sticker();
  const op: LayoutOp = {
    op: "add_block",
    page: 0,
    block: { rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 }, lines: [QTY_LINE], fontPt: 7, bold: true },
  };
  const res = applyLayoutOps(before, [op]);
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.applied.length, 1);
  assert.ok(LayoutDefSchema.safeParse(res.def).success);

  const added = blockOf(res.def, "b-add1");
  assert.ok(added, "new block gets a deterministic id");
  assert.deepEqual(added.rect, { col: 7, row: 42, colSpan: 27, rowSpan: 4 });
  assert.deepEqual(added.lines, [QTY_LINE]);
  assert.equal(added.fontPt, 7);
  assert.equal(added.bold, true);
  // The applied op reports the id it was given, so a follow-up op can use it.
  const appliedOp = res.applied[0];
  assert.equal(appliedOp.op === "add_block" && appliedOp.block.id, "b-add1");

  const changes = describeLayoutChanges(before, res.def);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "add_block");
  assert.equal(changes[0].page, 0);
  assert.equal(changes[0].blockId, "b-add1");
  assert.equal(changes[0].summary, `Added a block at col 7, row 42 (27×4): ${QTY_LINE}`);
});

// ---- purity ---------------------------------------------------------------

test("the input definition and the ops are never mutated", () => {
  const def = sticker();
  const ops: LayoutOp[] = [
    { op: "add_block", page: 0, block: { rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 }, lines: [QTY_LINE] } },
    { op: "set_rect", page: 0, blockId: "b-size", rect: { col: 2, row: 9, colSpan: 40, rowSpan: 7 } },
    { op: "set_block_props", page: 0, blockId: "b-style", props: { fontPt: 11, border: { widthMm: 0.3, color: "#000" } } },
    { op: "edit_line", page: 0, blockId: "b-colour", line: 1, oldText: "MADE IN BANGLADESH", newText: "MADE IN INDIA" },
    { op: "insert_line", page: 0, blockId: "b-size", line: 0, text: "EU" },
    { op: "remove_line", page: 0, blockId: "b-colour", line: 0, oldText: "COLOUR: {{colourName}}" },
    { op: "remove_block", page: 0, blockId: "b-ean" },
  ];
  const defBefore = snapshot(def);
  const opsBefore = snapshot(ops);
  const res = applyLayoutOps(def, ops);
  assert.equal(res.rejected.length, 0, snapshot(res.rejected));
  assert.equal(snapshot(def), defBefore);
  assert.equal(snapshot(ops), opsBefore);
  // …and the result shares no objects with the input.
  res.def.pages[0].blocks[0].lines.push("mutated");
  assert.equal(snapshot(def), defBefore);
});

test("no ops: the definition comes back equal, nothing applied", () => {
  const def = sticker();
  const res = applyLayoutOps(def, []);
  assert.deepEqual(res.applied, []);
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(describeLayoutChanges(def, res.def), []);
});

// ---- happy paths, one per op ----------------------------------------------

test("add_block keeps a supplied id and fills schema defaults", () => {
  const res = applyLayoutOps(sticker(), [
    { op: "add_block", page: 0, block: { id: "b-qty", rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 }, lines: ["QTY"] } },
  ]);
  assert.deepEqual(res.rejected, []);
  const b = blockOf(res.def, "b-qty");
  assert.ok(b);
  assert.equal(b.fontPt, 9);
  assert.equal(b.lineHeight, 1.4);
  assert.equal(b.fitWidth, false);
});

test("add_block ids stay unique across several adds", () => {
  const rect = (row: number) => ({ col: 7, row, colSpan: 10, rowSpan: 2 });
  const res = applyLayoutOps(sticker(), [
    { op: "add_block", page: 0, block: { rect: rect(40), lines: ["A"], fontPt: 4.5 } },
    { op: "add_block", page: 0, block: { rect: rect(42), lines: ["B"], fontPt: 4.5 } },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.ok(blockOf(res.def, "b-add1"));
  assert.ok(blockOf(res.def, "b-add2"));
});

test("a later op can address a block an earlier op added", () => {
  const res = applyLayoutOps(sticker(), [
    { op: "add_block", page: 0, block: { rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 }, lines: ["QTY"], fontPt: 7 } },
    { op: "edit_line", page: 0, blockId: "b-add1", line: 0, oldText: "QTY", newText: QTY_LINE },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(blockOf(res.def, "b-add1")?.lines, [QTY_LINE]);
});

test("remove_block drops the block", () => {
  const before = sticker();
  const res = applyLayoutOps(before, [{ op: "remove_block", page: 0, blockId: "b-ean" }]);
  assert.deepEqual(res.rejected, []);
  assert.equal(blockOf(res.def, "b-ean"), undefined);
  assert.equal(res.def.pages[0].blocks.length, 3);
  const changes = describeLayoutChanges(before, res.def);
  assert.deepEqual(
    changes.map((c) => [c.kind, c.blockId]),
    [["remove_block", "b-ean"]],
  );
  assert.equal(changes[0].summary, "Removed block b-ean at col 2, row 18 (46×20): {{barcode:ean13}}");
});

test("set_rect moves and resizes; the diff reports each separately", () => {
  const before = sticker();
  const res = applyLayoutOps(before, [
    { op: "set_rect", page: 0, blockId: "b-size", rect: { col: 4, row: 10, colSpan: 40, rowSpan: 6 } },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(blockOf(res.def, "b-size")?.rect, { col: 4, row: 10, colSpan: 40, rowSpan: 6 });
  const changes = describeLayoutChanges(before, res.def);
  assert.deepEqual(
    changes.map((c) => [c.kind, c.summary]),
    [
      ["move", "Moved block b-size from col 2, row 10 to col 4, row 10"],
      ["resize", "Resized block b-size from 46×6 to 40×6"],
    ],
  );
});

test("set_block_props changes only the named props", () => {
  const before = sticker();
  const res = applyLayoutOps(before, [
    {
      op: "set_block_props",
      page: 0,
      blockId: "b-colour",
      props: { fontPt: 5.5, bold: true, align: "center", fitHeight: true },
    },
  ]);
  assert.deepEqual(res.rejected, []);
  const b = blockOf(res.def, "b-colour");
  assert.ok(b);
  assert.equal(b.fontPt, 5.5);
  assert.equal(b.bold, true);
  assert.equal(b.align, "center");
  assert.equal(b.fitHeight, true);
  assert.equal(b.lineHeight, 1.4);
  assert.deepEqual(b.lines, ["COLOUR: {{colourName}}", "MADE IN BANGLADESH"]);
  const summaries = describeLayoutChanges(before, res.def).map((c) => c.summary);
  assert.deepEqual(summaries, [
    "Font 6.5 → 5.5 pt on block b-colour",
    "Bold on for block b-colour",
    "Alignment left → center on block b-colour",
    "Shrink to fit height on for block b-colour",
  ]);
});

test("set_block_props adds and removes a border (null removes)", () => {
  const withBorder = applyLayoutOps(sticker(), [
    { op: "set_block_props", page: 0, blockId: "b-style", props: { border: { widthMm: 0.3, color: "#000000" } } },
  ]);
  assert.deepEqual(withBorder.rejected, []);
  assert.equal(blockOf(withBorder.def, "b-style")?.border?.widthMm, 0.3);
  assert.deepEqual(
    describeLayoutChanges(sticker(), withBorder.def).map((c) => c.summary),
    ["Border added to block b-style (0.3 mm #000000)"],
  );

  const without = applyLayoutOps(withBorder.def, [
    { op: "set_block_props", page: 0, blockId: "b-style", props: { border: null } },
  ]);
  assert.deepEqual(without.rejected, []);
  assert.equal(blockOf(without.def, "b-style")?.border, undefined);
  assert.deepEqual(
    describeLayoutChanges(withBorder.def, without.def).map((c) => c.summary),
    ["Border removed from block b-style"],
  );
});

test("edit_line replaces exactly the quoted line", () => {
  const before = sticker();
  const res = applyLayoutOps(before, [
    { op: "edit_line", page: 0, blockId: "b-size", line: 0, oldText: "SIZE: {{size}}", newText: "STR: {{size}}" },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(blockOf(res.def, "b-size")?.lines, ["STR: {{size}}"]);
  const changes = describeLayoutChanges(before, res.def);
  assert.deepEqual(
    changes.map((c) => [c.kind, c.summary]),
    [["text", 'Line 1 on block b-size: "SIZE: {{size}}" → "STR: {{size}}"']],
  );
});

test("insert_line inserts at the index; an index equal to the line count appends", () => {
  const before = sticker();
  const res = applyLayoutOps(before, [
    { op: "insert_line", page: 0, blockId: "b-colour", line: 1, text: QTY_LINE },
    { op: "insert_line", page: 0, blockId: "b-colour", line: 3, text: "100% COTTON" },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(blockOf(res.def, "b-colour")?.lines, [
    "COLOUR: {{colourName}}",
    QTY_LINE,
    "MADE IN BANGLADESH",
    "100% COTTON",
  ]);
  assert.deepEqual(
    describeLayoutChanges(before, res.def).map((c) => [c.kind, c.summary]),
    [
      ["text", `Added line 2 to block b-colour: ${JSON.stringify(QTY_LINE)}`],
      ["text", 'Added line 4 to block b-colour: "100% COTTON"'],
    ],
  );
});

test("remove_line removes the quoted line", () => {
  const before = sticker();
  const res = applyLayoutOps(before, [
    { op: "remove_line", page: 0, blockId: "b-colour", line: 1, oldText: "MADE IN BANGLADESH" },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(blockOf(res.def, "b-colour")?.lines, ["COLOUR: {{colourName}}"]);
  assert.deepEqual(
    describeLayoutChanges(before, res.def).map((c) => c.summary),
    ['Removed line 2 from block b-colour: "MADE IN BANGLADESH"'],
  );
});

// ---- rejections -------------------------------------------------------------

function rejectsWith(op: unknown, pattern: RegExp, def: LayoutDef = sticker()) {
  const res = applyLayoutOps(def, [op as LayoutOp]);
  assert.equal(res.applied.length, 0, `expected a rejection for ${snapshot(op)}`);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, pattern);
  // A rejected op leaves the definition as it was.
  assert.deepEqual(describeLayoutChanges(def, res.def), []);
  return res.rejected[0];
}

test("a rejected op does not stop the ops after it", () => {
  const res = applyLayoutOps(sticker(), [
    { op: "edit_line", page: 0, blockId: "b-size", line: 0, oldText: "WRONG", newText: "X" },
    { op: "remove_block", page: 0, blockId: "b-nope" },
    { op: "set_block_props", page: 0, blockId: "b-style", props: { bold: true } },
  ]);
  assert.equal(res.rejected.length, 2);
  assert.equal(res.applied.length, 1);
  assert.equal(blockOf(res.def, "b-style")?.bold, true);
  assert.deepEqual(blockOf(res.def, "b-size")?.lines, ["SIZE: {{size}}"]);
  // The rejected entry carries the op as sent.
  assert.deepEqual(res.rejected[1].op, { op: "remove_block", page: 0, blockId: "b-nope" });
});

test("rejects an unknown op and a malformed op", () => {
  rejectsWith({ op: "rotate_block", page: 0, blockId: "b-size" }, /unknown op "rotate_block"/);
  rejectsWith({ page: 0 }, /unknown op null/);
  rejectsWith("edit_line", /must be an object/);
  rejectsWith({ op: "edit_line", page: 0, blockId: "b-size", line: 0, newText: "x" }, /edit_line: oldText/);
  rejectsWith({ op: "set_rect", page: 0, blockId: "b-size", rect: { col: 1.5, row: 0, colSpan: 2, rowSpan: 2 } }, /rect\.col/);
});

test("rejects a page or block that does not exist", () => {
  rejectsWith({ op: "remove_block", page: 1, blockId: "b-size" }, /page 1 does not exist.*has 1 \(0\)/);
  rejectsWith({ op: "remove_block", page: -1, blockId: "b-size" }, /page -1 does not exist/);
  const r = rejectsWith({ op: "remove_block", page: 0, blockId: "b-gone" }, /no block "b-gone" on page 0/);
  assert.match(r.reason, /b-style, b-size, b-ean, b-colour/);
});

test("rejects a rect outside the page grid", () => {
  const add = (rect: { col: number; row: number; colSpan: number; rowSpan: number }) => ({
    op: "add_block",
    page: 0,
    block: { rect, lines: ["X"] },
  });
  rejectsWith(add({ col: 30, row: 42, colSpan: 27, rowSpan: 4 }), /horizontally.*57.*50 columns/);
  rejectsWith(add({ col: 7, row: 58, colSpan: 27, rowSpan: 4 }), /vertically.*62.*60 rows/);
  rejectsWith(add({ col: -1, row: 0, colSpan: 2, rowSpan: 2 }), /0 or more/);
  rejectsWith(add({ col: 0, row: 0, colSpan: 0, rowSpan: 2 }), /at least 1/);
  rejectsWith({ op: "set_rect", page: 0, blockId: "b-size", rect: { col: 2, row: 10, colSpan: 49, rowSpan: 6 } }, /horizontally/);
});

test("the legacy 12×12 grid applies to a page without gridCols/gridRows", () => {
  const def = LayoutDefSchema.parse({
    pages: [{ id: "p1", widthMm: 60, heightMm: 40, blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 6, rowSpan: 2 }, lines: ["A"] }] }],
  });
  rejectsWith({ op: "set_rect", page: 0, blockId: "b1", rect: { col: 7, row: 0, colSpan: 6, rowSpan: 2 } }, /12 columns/, def);
});

test("rejects an unknown variable", () => {
  rejectsWith(
    { op: "insert_line", page: 0, blockId: "b-size", line: 1, text: "{{polybagQuantity}} PCS" },
    /unknown variable \{\{polybagQuantity\}\}/,
  );
  rejectsWith(
    { op: "add_block", page: 0, block: { rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 }, lines: ["{{nope}}"] } },
    /unknown variable \{\{nope\}\}/,
  );
});

test("rejects a bad token argument", () => {
  rejectsWith(
    { op: "insert_line", page: 0, blockId: "b-size", line: 1, text: "{{composition}}" },
    /needs a language/,
  );
});

test("rejects a malformed conditional", () => {
  rejectsWith(
    { op: "edit_line", page: 0, blockId: "b-size", line: 0, oldText: "SIZE: {{size}}", newText: '{{if polybagQty != ""}}{{polybagQty}} PCS' },
    /malformed conditional/,
  );
  rejectsWith(
    { op: "insert_line", page: 0, blockId: "b-size", line: 0, text: "{{if bogusField == X}}A{{endif}}" },
    /conditional checks unknown variable "bogusField"/,
  );
});

test("rejects a broken calculated field", () => {
  rejectsWith(
    { op: "insert_line", page: 0, blockId: "b-size", line: 0, text: "{{= nope * 2 }}" },
    /unknown field "nope"/,
  );
});

test("rejects token-shaped text no parser recognises", () => {
  rejectsWith({ op: "insert_line", page: 0, blockId: "b-size", line: 0, text: "{{ polybagQty }} PCS" }, /unrecognised/);
  rejectsWith({ op: "insert_line", page: 0, blockId: "b-size", line: 0, text: "{{polybag_qty}}" }, /unrecognised/);
});

test("rejects a line break inside a line and an over-long line", () => {
  rejectsWith({ op: "insert_line", page: 0, blockId: "b-size", line: 0, text: "A\nB" }, /line break/);
  rejectsWith({ op: "insert_line", page: 0, blockId: "b-size", line: 0, text: "x".repeat(501) }, /at most 500 characters/);
});

test("edit_line and remove_line reject when oldText does not match", () => {
  const r = rejectsWith(
    { op: "edit_line", page: 0, blockId: "b-size", line: 0, oldText: "SIZE {{size}}", newText: "X" },
    /is "SIZE: \{\{size\}\}", not "SIZE \{\{size\}\}"/,
  );
  assert.match(r.reason, /re-read/);
  rejectsWith(
    { op: "remove_line", page: 0, blockId: "b-colour", line: 0, oldText: "MADE IN BANGLADESH" },
    /not "MADE IN BANGLADESH"/,
  );
});

test("line indexes out of range are rejected", () => {
  rejectsWith({ op: "edit_line", page: 0, blockId: "b-size", line: 1, oldText: "x", newText: "y" }, /line 1 does not exist.*1 line \(0\)/);
  rejectsWith({ op: "remove_line", page: 0, blockId: "b-colour", line: 2, oldText: "x" }, /line 2 does not exist.*0–1/);
  rejectsWith({ op: "insert_line", page: 0, blockId: "b-size", line: 2, text: "x" }, /insert position 2.*0–1/);
  rejectsWith({ op: "insert_line", page: 0, blockId: "b-size", line: -1, text: "x" }, /insert position -1/);
});

test("edit_line with identical text is a no-op and rejected", () => {
  rejectsWith(
    { op: "edit_line", page: 0, blockId: "b-size", line: 0, oldText: "SIZE: {{size}}", newText: "SIZE: {{size}}" },
    /nothing to change/,
  );
});

test("add_block rejects a duplicate id, an empty block and stray props", () => {
  const rect = { col: 7, row: 42, colSpan: 27, rowSpan: 4 };
  rejectsWith({ op: "add_block", page: 0, block: { id: "b-size", rect, lines: ["X"] } }, /"b-size" is already used/);
  rejectsWith({ op: "add_block", page: 0, block: { rect, lines: [] } }, /at least one line/);
  rejectsWith(
    { op: "add_block", page: 0, block: { rect, lines: ["X"], border: { widthMm: 0.3, color: "#000" } } },
    /Unrecognized key.*set_block_props/,
  );
  rejectsWith({ op: "add_block", page: 0, block: { rect, lines: ["X"], fontPt: 200 } }, /fontPt must be between 1 and 144/);
});

test("set_block_props rejects out-of-range values, empty props and props with their own op", () => {
  rejectsWith({ op: "set_block_props", page: 0, blockId: "b-size", props: { fontPt: 0.5 } }, /fontPt must be between/);
  rejectsWith({ op: "set_block_props", page: 0, blockId: "b-size", props: { lineHeight: 4 } }, /lineHeight must be between 1 and 3/);
  rejectsWith({ op: "set_block_props", page: 0, blockId: "b-size", props: {} }, /props is empty/);
  rejectsWith(
    { op: "set_block_props", page: 0, blockId: "b-size", props: { lines: ["x"] } },
    /Unrecognized key.*use set_rect/,
  );
  rejectsWith(
    { op: "set_block_props", page: 0, blockId: "b-size", props: { border: { widthMm: 0.3, color: "black" } } },
    /props\.border\.color/,
  );
  rejectsWith({ op: "set_block_props", page: 0, blockId: "b-size", props: { align: "justify" } }, /props\.align/);
});

test("a block already holding 100 lines takes no more", () => {
  const def = sticker();
  def.pages[0].blocks[1].lines = Array.from({ length: 100 }, (_, i) => `L${i}`);
  rejectsWith({ op: "insert_line", page: 0, blockId: "b-size", line: 0, text: "one too many" }, /maximum of 100 lines/, def);
});

test("an invalid input definition rejects every op instead of throwing", () => {
  const bad = { pages: [{ id: "p1", widthMm: 1, heightMm: 40, blocks: [] }] } as unknown as LayoutDef;
  const ops: LayoutOp[] = [{ op: "remove_block", page: 0, blockId: "b1" }];
  const res = applyLayoutOps(bad, ops);
  assert.equal(res.applied.length, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /current layout definition is invalid/);
});

// ---- ids from parseLayoutDef ----------------------------------------------

test("blocks saved without ids are addressable by their parseLayoutDef ids", () => {
  const legacy = {
    pages: [
      {
        id: "p1",
        widthMm: 50,
        heightMm: 60,
        gridCols: 50,
        gridRows: 60,
        blocks: [
          { rect: { col: 0, row: 0, colSpan: 50, rowSpan: 10 }, lines: ["{{styleNumber}}"] },
          { rect: { col: 0, row: 10, colSpan: 50, rowSpan: 10 }, lines: ["{{size}}"] },
        ],
      },
    ],
  } as unknown as LayoutDef;
  const res = applyLayoutOps(legacy, [
    { op: "set_block_props", page: 0, blockId: "b-r1", props: { fontPt: 12 } },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(
    res.def.pages[0].blocks.map((b) => [b.id, b.fontPt]),
    [
      ["b-r0", 9],
      ["b-r1", 12],
    ],
  );
  // Diffing the legacy original against the result shows only the edit.
  assert.deepEqual(
    describeLayoutChanges(legacy, res.def).map((c) => c.summary),
    ["Font 9 → 12 pt on block b-r1"],
  );
});

// ---- warnings ---------------------------------------------------------------

test("overlap with another block is a warning, not a rejection", () => {
  const res = applyLayoutOps(sticker(), [
    { op: "add_block", page: 0, block: { rect: { col: 7, row: 36, colSpan: 27, rowSpan: 4 }, lines: ["QTY"], fontPt: 7 } },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.equal(res.applied.length, 1);
  assert.deepEqual(res.warnings, ["Block b-add1 overlaps block b-ean — check the proof that they don't collide."]);
});

test("moving a block onto another warns; touching edges do not", () => {
  const onto = applyLayoutOps(sticker(), [
    { op: "set_rect", page: 0, blockId: "b-size", rect: { col: 2, row: 5, colSpan: 46, rowSpan: 6 } },
  ]);
  assert.deepEqual(onto.warnings, ["Block b-size overlaps block b-style — check the proof that they don't collide."]);
  const adjacent = applyLayoutOps(sticker(), [
    { op: "set_rect", page: 0, blockId: "b-size", rect: { col: 2, row: 8, colSpan: 46, rowSpan: 6 } },
  ]);
  assert.deepEqual(adjacent.warnings, []);
});

test("text too wide for the block warns that it will wrap", () => {
  const res = applyLayoutOps(sticker(), [
    {
      op: "add_block",
      page: 0,
      // 25 characters at 5 pt ≈ 24 mm: wraps onto 3 rows, which still fit
      // the 10 mm height — so only the width warns.
      block: { rect: { col: 7, row: 38, colSpan: 10, rowSpan: 10 }, lines: ["SOLID PACK OF FIVE PIECES"], fontPt: 5 },
    },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(res.warnings, [
    "Block b-add1: the longest line is ~24.25 mm wide at 5 pt but the block is 10 mm wide — it will likely wrap.",
  ]);
});

test("too many lines for the block height warns that it will overflow", () => {
  const res = applyLayoutOps(sticker(), [
    { op: "add_block", page: 0, block: { rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 }, lines: ["A", "B", "C"], fontPt: 7 } },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.equal(res.warnings.length, 1, snapshot(res.warnings));
  assert.match(res.warnings[0], /^Block b-add1: its text needs ~10\.37 mm of height \(7 pt, line height 1\.4\) but the block is 4 mm tall — it will likely overflow\.$/);
});

test("the default 9 pt is too tall for a 4 mm block — a warning, and shrink-to-fit silences it", () => {
  const add: LayoutOp = {
    op: "add_block",
    page: 0,
    block: { rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 }, lines: [QTY_LINE] },
  };
  const res = applyLayoutOps(sticker(), [add]);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /will likely overflow/);
  const fitted = applyLayoutOps(sticker(), [
    add,
    { op: "set_block_props", page: 0, blockId: "b-add1", props: { fitHeight: true } },
  ]);
  assert.deepEqual(fitted.warnings, []);
});

test("fitWidth blocks never warn on width", () => {
  const res = applyLayoutOps(sticker(), [
    {
      op: "add_block",
      page: 0,
      block: {
        rect: { col: 7, row: 38, colSpan: 10, rowSpan: 10 },
        lines: ["SOLID PACK OF FIVE PIECES"],
        fontPt: 5,
        fitWidth: true,
      },
    },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(res.warnings, []);
});

test("a conditional is estimated by its longer branch", () => {
  const line = "{{if polybagQty != \"\"}}AN EXTREMELY LONG WORDING FOR THE QUANTITY{{else}}X{{endif}}";
  const res = applyLayoutOps(sticker(), [
    { op: "add_block", page: 0, block: { rect: { col: 7, row: 40, colSpan: 27, rowSpan: 7 }, lines: [line], fontPt: 7 } },
  ]);
  assert.match(res.warnings.join("\n"), /will likely wrap/);
});

test("barcode blocks are left to the proof (no size estimate)", () => {
  const res = applyLayoutOps(sticker(), [
    { op: "set_rect", page: 0, blockId: "b-ean", rect: { col: 2, row: 18, colSpan: 10, rowSpan: 2 } },
  ]);
  assert.deepEqual(res.warnings, []);
});

test("a font under 5 pt warns", () => {
  const res = applyLayoutOps(sticker(), [
    { op: "set_block_props", page: 0, blockId: "b-colour", props: { fontPt: 4 } },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.ok(res.warnings.some((w) => /4 pt — below the 5 pt minimum/.test(w)), snapshot(res.warnings));
});

test("untouched blocks never warn, and a block added then removed says nothing", () => {
  const def = sticker();
  // Pre-existing overlap the patch didn't cause.
  def.pages[0].blocks[1].rect = { col: 2, row: 4, colSpan: 46, rowSpan: 6 };
  const res = applyLayoutOps(def, [
    { op: "add_block", page: 0, block: { rect: { col: 7, row: 36, colSpan: 27, rowSpan: 4 }, lines: ["QTY"] } },
    { op: "remove_block", page: 0, blockId: "b-add1" },
    { op: "edit_line", page: 0, blockId: "b-colour", line: 1, oldText: "MADE IN BANGLADESH", newText: "MADE IN INDIA" },
  ]);
  assert.deepEqual(res.rejected, []);
  assert.deepEqual(res.warnings, []);
});

// ---- describeLayoutChanges beyond ops ---------------------------------------

test("describe: a replaced middle line pairs up as an edit, surrounding lines stay", () => {
  const before = sticker();
  const after = structuredClone(before);
  after.pages[0].blocks[3].lines = ["COLOUR: {{colourName}}", "MADE IN INDIA", "EXTRA"];
  assert.deepEqual(
    describeLayoutChanges(before, after).map((c) => c.summary),
    ['Line 2 on block b-colour: "MADE IN BANGLADESH" → "MADE IN INDIA"', 'Added line 3 to block b-colour: "EXTRA"'],
  );
});

test("describe: page-level and settings changes are reported as kind page", () => {
  const before = sticker();
  const after = structuredClone(before);
  after.pages[0].heightMm = 70;
  after.pages[0].gridRows = 70;
  after.pages[0].omitWhenEmpty = true;
  after.settings = { ...LayoutDefSchema.parse({ pages: before.pages, settings: {} }).settings!, repeatBy: "ean" };
  const changes = describeLayoutChanges(before, after);
  assert.ok(changes.every((c) => c.kind === "page"));
  assert.deepEqual(
    changes.map((c) => c.summary),
    [
      "Page size 50×60 → 50×70 mm",
      "Page grid 50×60 → 50×70",
      "Omit when empty false → true",
      'Layout settings changed: repeatBy "none" → "ean"',
    ],
  );
});

test("describe: multi-page layouts name the page (1-based) and report added pages", () => {
  const before = sticker();
  const after = structuredClone(before);
  after.pages.push({ ...structuredClone(before.pages[0]), id: "p2", title: "Back" });
  const res = applyLayoutOps(after, [
    { op: "set_block_props", page: 1, blockId: "b-style", props: { fontPt: 10 } },
  ]);
  assert.deepEqual(res.rejected, []);
  const changes = describeLayoutChanges(before, res.def);
  assert.deepEqual(
    changes.map((c) => [c.kind, c.page, c.summary]),
    [["page", 1, 'Added page 2 "Back" (50×60 mm, 4 blocks)']],
  );
  const secondEdit = describeLayoutChanges(after, res.def);
  assert.deepEqual(
    secondEdit.map((c) => [c.kind, c.page, c.blockId, c.summary]),
    [["props", 1, "b-style", "Font 9 → 10 pt on block b-style (page 2)"]],
  );
});

// ---- validateLayoutLine ------------------------------------------------------

test("validateLayoutLine accepts the publish-valid shapes", () => {
  for (const line of [
    "",
    "PLAIN TEXT",
    QTY_LINE,
    "{{barcode:ean13:8}}",
    "{{if productGroup contains Set}}PER SÆT{{else}}KR.{{endif}}",
    "{{= qtyPerCarton * 2 }} PCS",
    "{{composition:en}}",
  ]) {
    assert.deepEqual(validateLayoutLine(line), [], line);
  }
});
