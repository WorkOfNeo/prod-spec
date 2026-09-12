import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_CLIPBOARD_KEY,
  blocksForPaste,
  clearBlockClipboard,
  readBlockClipboard,
  remapRectToGrid,
  writeBlockClipboard,
  type StorageLike,
} from "./block-clipboard";
import { LayoutBlockSchema, LayoutPageSchema, type LayoutBlock } from "./schema";

// A stand-in for localStorage — node has none, and the module takes one so
// the failure modes (unavailable, full, corrupt) can be exercised directly.
function fakeStorage(initial?: string): StorageLike & { dump: () => string | null } {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_k, v) => {
      value = v;
    },
    removeItem: () => {
      value = null;
    },
    dump: () => value,
  };
}
const throwingStorage: StorageLike = {
  getItem: () => {
    throw new Error("SecurityError: storage disabled");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError: storage disabled");
  },
};

function block(patch: Partial<LayoutBlock> = {}): LayoutBlock {
  return LayoutBlockSchema.parse({
    id: "b1",
    rect: { col: 0, row: 0, colSpan: 4, rowSpan: 2 },
    lines: ["Hello"],
    ...patch,
  });
}
const ids = () => {
  let n = 0;
  return () => `new-${++n}`;
};

// ---- round trip --------------------------------------------------------

test("blocks survive a write/read round trip", () => {
  const s = fakeStorage();
  const blocks = [block({ fontPt: 6, bold: true }), block({ id: "b2", lines: ["{{orderNo}}"] })];
  assert.equal(writeBlockClipboard({ blocks, grid: { cols: 12, rows: 12 }, layoutName: "Care Label" }, s), true);
  const clip = readBlockClipboard(s);
  assert.ok(clip);
  assert.equal(clip.layoutName, "Care Label");
  assert.equal(clip.blocks.length, 2);
  assert.equal(clip.blocks[0].fontPt, 6);
  assert.deepEqual(clip.blocks[1].lines, ["{{orderNo}}"]);
});

test("an empty selection is not written", () => {
  const s = fakeStorage();
  assert.equal(writeBlockClipboard({ blocks: [], grid: { cols: 12, rows: 12 }, layoutName: "x" }, s), false);
  assert.equal(readBlockClipboard(s), null);
});

test("clearing empties the clipboard", () => {
  const s = fakeStorage();
  writeBlockClipboard({ blocks: [block()], grid: { cols: 12, rows: 12 }, layoutName: "x" }, s);
  clearBlockClipboard(s);
  assert.equal(readBlockClipboard(s), null);
});

// ---- untrusted storage -------------------------------------------------

test("a corrupt or foreign payload reads as empty, never throws", () => {
  for (const junk of [
    "not json at all",
    "{}",
    '{"v":1}',
    '{"v":99,"copiedAt":"x","layoutName":"y","grid":{"cols":12,"rows":12},"blocks":[]}',
    // Right shape, but a block that no longer satisfies the schema (fontPt
    // above the 144 pt ceiling) — exactly what a stale payload looks like.
    '{"v":1,"copiedAt":"x","layoutName":"y","grid":{"cols":12,"rows":12},"blocks":[{"fontPt":9999,"lines":[],"rect":{"col":0,"row":0,"colSpan":1,"rowSpan":1}}]}',
  ]) {
    assert.equal(readBlockClipboard(fakeStorage(junk)), null, `should reject: ${junk.slice(0, 40)}`);
  }
});

test("storage that throws degrades to an empty clipboard", () => {
  // Private-browsing modes throw on access rather than returning null.
  assert.equal(readBlockClipboard(throwingStorage), null);
  assert.equal(
    writeBlockClipboard({ blocks: [block()], grid: { cols: 12, rows: 12 }, layoutName: "x" }, throwingStorage),
    false,
  );
  assert.doesNotThrow(() => clearBlockClipboard(throwingStorage));
});

test("the stored key is namespaced", () => {
  const s = fakeStorage();
  writeBlockClipboard({ blocks: [block()], grid: { cols: 12, rows: 12 }, layoutName: "x" }, s);
  assert.match(BLOCK_CLIPBOARD_KEY, /^prodspec\./);
  assert.ok(s.dump());
});

// ---- the remap ---------------------------------------------------------

test("a rect scales proportionally between grids", () => {
  // Half-width block on a 12-col grid → half-width on a 24-col grid.
  assert.deepEqual(
    remapRectToGrid({ col: 0, row: 0, colSpan: 6, rowSpan: 6 }, { cols: 12, rows: 12 }, { cols: 24, rows: 24 }),
    { col: 0, row: 0, colSpan: 12, rowSpan: 12 },
  );
});

test("a remapped rect always lands inside the target grid", () => {
  const from = { cols: 25, rows: 19 };
  // The real case: a wide landscape layout pasted into a narrow care label.
  const to = { cols: 9, rows: 23 };
  for (const rect of [
    { col: 0, row: 0, colSpan: 25, rowSpan: 19 },
    { col: 24, row: 18, colSpan: 1, rowSpan: 1 },
    { col: 20, row: 15, colSpan: 5, rowSpan: 4 },
    { col: 12, row: 9, colSpan: 6, rowSpan: 6 },
  ]) {
    const out = remapRectToGrid(rect, from, to);
    assert.ok(out.col >= 0 && out.row >= 0, `negative origin: ${JSON.stringify(out)}`);
    assert.ok(out.colSpan >= 1 && out.rowSpan >= 1, `collapsed span: ${JSON.stringify(out)}`);
    assert.ok(out.col + out.colSpan <= to.cols, `overflows cols: ${JSON.stringify(out)}`);
    assert.ok(out.row + out.rowSpan <= to.rows, `overflows rows: ${JSON.stringify(out)}`);
  }
});

// ---- pasting -----------------------------------------------------------

test("pasted blocks get fresh ids and keep their formatting", () => {
  const s = fakeStorage();
  writeBlockClipboard(
    {
      blocks: [block({ id: "same", fontPt: 6, bold: true }), block({ id: "same", lines: ["B"] })],
      grid: { cols: 12, rows: 12 },
      layoutName: "src",
    },
    s,
  );
  const out = blocksForPaste(readBlockClipboard(s)!, { cols: 12, rows: 12 }, ids());
  assert.deepEqual(
    out.map((b) => b.id),
    ["new-1", "new-2"],
    "duplicate source ids must not survive — ids drive selection",
  );
  assert.equal(out[0].fontPt, 6);
  assert.equal(out[0].bold, true);
});

test("pasting into a different grid keeps every block publishable", () => {
  // The regression this guards: LayoutPageSchema's superRefine rejects an
  // out-of-grid rect, so a bad paste would only surface at publish time.
  const s = fakeStorage();
  writeBlockClipboard(
    {
      blocks: [
        block({ id: "a", rect: { col: 0, row: 0, colSpan: 25, rowSpan: 4 } }),
        block({ id: "b", rect: { col: 20, row: 14, colSpan: 5, rowSpan: 5 } }),
      ],
      grid: { cols: 25, rows: 19 },
      layoutName: "wide",
    },
    s,
  );
  const target = { cols: 9, rows: 23 };
  const pasted = blocksForPaste(readBlockClipboard(s)!, target, ids());
  const page = LayoutPageSchema.safeParse({
    id: "p1",
    title: "Care label",
    widthMm: 35,
    heightMm: 90,
    gridCols: target.cols,
    gridRows: target.rows,
    blocks: pasted,
  });
  assert.ok(page.success, `pasted page failed validation: ${page.error?.message}`);
});

test("a pasted block does not alias the clipboard payload", () => {
  const s = fakeStorage();
  writeBlockClipboard(
    {
      blocks: [
        block({
          lines: ["one"],
          border: { widthMm: 0.3, color: "#000000", pad: { topMm: 1, rightMm: 1, bottomMm: 1, leftMm: 1 } },
        }),
      ],
      grid: { cols: 12, rows: 12 },
      layoutName: "src",
    },
    s,
  );
  const clip = readBlockClipboard(s)!;
  const [pasted] = blocksForPaste(clip, { cols: 12, rows: 12 }, ids());
  pasted.lines.push("two");
  pasted.border!.pad!.topMm = 9;
  assert.deepEqual(clip.blocks[0].lines, ["one"]);
  assert.equal(clip.blocks[0].border!.pad!.topMm, 1);
});

test("pasting twice yields two independent sets", () => {
  const s = fakeStorage();
  writeBlockClipboard({ blocks: [block()], grid: { cols: 12, rows: 12 }, layoutName: "src" }, s);
  const clip = readBlockClipboard(s)!;
  const gen = ids();
  const first = blocksForPaste(clip, { cols: 12, rows: 12 }, gen);
  const second = blocksForPaste(clip, { cols: 12, rows: 12 }, gen);
  assert.notEqual(first[0].id, second[0].id);
  first[0].lines.push("changed");
  assert.deepEqual(second[0].lines, ["Hello"]);
});
