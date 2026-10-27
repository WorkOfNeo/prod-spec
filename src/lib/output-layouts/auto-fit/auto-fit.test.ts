import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load (nothing here queries).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

type Geometry = typeof import("./geometry");
type LayoutDef = import("../schema").LayoutDef;
type LayoutPage = import("../schema").LayoutPage;
let LayoutDefSchema: typeof import("../schema").LayoutDefSchema;
let geo: Geometry;
let compactAround: typeof import("./compact").compactAround;
let autoFitBlock: typeof import("./fit-block").autoFitBlock;
let largestFitting: typeof import("./fit-block").largestFitting;
let buildSampleStyleData: typeof import("../../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ LayoutDefSchema } = await import("../schema"));
  geo = await import("./geometry");
  ({ compactAround } = await import("./compact"));
  ({ autoFitBlock, largestFitting } = await import("./fit-block"));
  ({ buildSampleStyleData } = await import("../../pdf/sample-data"));
});

// A synthetic 30 × 60 mm care label face: 12 × 12 grid (5 mm rows, no
// margins), a sewing line 5 mm from the top. Plain-text lines only, so the
// fake measurer below can model them without a browser.
function label(blocks: Array<Record<string, unknown>>, page: Record<string, unknown> = {}): LayoutDef {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "Front",
        widthMm: 30,
        heightMm: 60,
        gridCols: 12,
        gridRows: 12,
        margins: { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 },
        sewingLines: [{ edge: "top", offsetMm: 5 }],
        ...page,
        blocks,
      },
    ],
  });
}

const lines = (n: number, text = "TEXT") => Array.from({ length: n }, (_, i) => `${text} ${i + 1}`);
const rect = (row: number, rowSpan: number) => ({ col: 0, row, colSpan: 12, rowSpan });

// ---- geometry ---------------------------------------------------------------

test("refineGrid splits rows exactly and simplifyGrid undoes it", () => {
  const page = label([{ rect: rect(2, 3), lines: ["A"] }]).pages[0];
  const { page: fine, factor } = geo.refineGrid(page, 1.1);
  assert.equal(factor, 5); // 5 mm rows → 1 mm sub-rows
  assert.equal(fine.gridRows, 60);
  assert.deepEqual(fine.blocks[0].rect, { col: 0, row: 10, colSpan: 12, rowSpan: 15 });
  assert.equal(geo.rowHeightMm(fine), 1);
  const back = geo.simplifyGrid(fine);
  assert.equal(back.gridRows, 12);
  assert.deepEqual(back.blocks[0].rect, page.blocks[0].rect);
});

test("refineGrid never exceeds the 120-row grid", () => {
  const page = label([{ rect: rect(0, 1), lines: ["A"] }], { heightMm: 600, gridRows: 12 }).pages[0];
  const { page: fine } = geo.refineGrid(page, 1.1);
  assert.ok((fine.gridRows ?? 0) <= 120);
});

test("sectionRows keeps the seam allowance and the fold clear", () => {
  const page = label([], { gridRows: 60, foldLine: "horizontal" }).pages[0];
  // seam 5 mm + 1 mm clear → rows 0–5 reserved; fold 30 ± 1.5 mm → rows 28–31.
  assert.deepEqual(geo.sectionRows(page), [
    [6, 27],
    [32, 59],
  ]);
});

test("freeBands are the gaps between ink, clearance applied, tallest first", () => {
  const ink = [
    { block: 0, top: 10, bottom: 15, left: 0, right: 30 },
    { block: 1, top: 30, bottom: 32, left: 0, right: 30 },
  ];
  const bands = geo.freeBands([[6, 60]], ink, 1, 2.5);
  assert.deepEqual(bands, [
    [33, 60],
    [16, 29],
    [6, 9],
  ]);
  assert.deepEqual(geo.bandRows(geo.refineGrid(label([]).pages[0]).page, [16.4, 29]), [17, 28]);
});

// ---- compaction ---------------------------------------------------------------

test("compactAround slides blocks to their needs and stretches the target", () => {
  const def = label([
    { id: "care", rect: rect(2, 5), lines: ["x"] }, // 10–35 mm
    { id: "cert", rect: rect(7, 2), lines: ["{{cert:oekotex}}"] }, // 35–45 mm, conditional
    { id: "target", rect: rect(10, 2), lines: ["x"] }, // 50–60 mm
  ]);
  const { page } = geo.refineGrid(def.pages[0], 1.1);
  const res = compactAround(page, 2, [6, 59], [8, 0, 0], { conditional: new Set([1]), gapMm: 1 });
  assert.ok(res);
  const [care, cert, target] = res.page.blocks.map((b) => b.rect!);
  assert.deepEqual([care.row, care.rowSpan], [6, 9]); // needs 8.2 mm → 9 rows, slid to the section top
  assert.deepEqual([cert.row, cert.rowSpan], [16, 10]); // conditional keeps its 10 rows
  assert.deepEqual([target.row, target.rowSpan], [27, 33]); // everything left, full width
  assert.equal(res.targetHeightMm, 33);
  assert.deepEqual([...res.affected].sort(), [0, 1]);
});

test("compactAround returns null when the blocks alone fill the section", () => {
  const def = label([
    { rect: rect(2, 9), lines: ["x"] },
    { rect: rect(11, 1), lines: ["x"] },
  ]);
  const { page } = geo.refineGrid(def.pages[0], 1.1);
  assert.equal(compactAround(page, 1, [6, 59], [54, 0]), null);
});

// ---- search -------------------------------------------------------------------

test("largestFitting finds the boundary on the step grid", async () => {
  assert.equal(await largestFitting(2, 7, 0.25, async (pt) => pt <= 4.6), 4.5);
  assert.equal(await largestFitting(2, 7, 0.25, async () => true), 7);
  assert.equal(await largestFitting(2, 7, 0.25, async () => false), 0);
});

// ---- the three tiers, against a fake measurer -----------------------------------
//
// Models every line as fontPt × lineHeight tall (no wrapping) and places it by
// the block's valign — enough to drive the solver deterministically.

const PT_MM = 25.4 / 72;
function fakeEvaluate<T>(html: string): Promise<T> {
  const blocks: Array<{ needMm: number; boxMm: number }> = [];
  const ink: Array<{ block: number; top: number; bottom: number; left: number; right: number }> = [];
  for (const chunk of html.split('<div class="ol-block').slice(1)) {
    const style = /style="([^"]*)"/.exec(chunk)![1];
    const num = (re: RegExp) => Number(re.exec(style)![1]);
    const top = num(/top: ([\d.]+)mm/);
    const box = num(/height: ([\d.]+)mm/);
    const lineMm = num(/font-size: ([\d.]+)pt/) * num(/line-height: ([\d.]+)/) * PT_MM;
    const texts = [...chunk.matchAll(/<div class="ol-line">(.*?)<\/div>/g)].map((m) => m[1]);
    const inked = texts.filter((t) => t !== "&nbsp;");
    const need = inked.length ? texts.length * lineMm : 0;
    const offset = style.includes("justify-content: center")
      ? (box - need) / 2
      : style.includes("justify-content: flex-end")
        ? box - need
        : 0;
    texts.forEach((t, i) => {
      if (t === "&nbsp;") return;
      ink.push({ block: blocks.length, top: top + offset + i * lineMm, bottom: top + offset + (i + 1) * lineMm, left: 0, right: 30 });
    });
    blocks.push({ needMm: need, boxMm: box });
  }
  return Promise.resolve({ blocks, ink } as T);
}

async function fit(def: LayoutDef, blockIndex: number) {
  return autoFitBlock({
    def,
    pageIndex: 0,
    blockIndex,
    samples: [{ styleData: buildSampleStyleData(), label: "sample" }],
    evaluate: fakeEvaluate,
    options: { capPt: 6 },
  });
}

const targetOf = (page: LayoutPage) => page.blocks.find((b) => b.id === "target")!;

test("tier 1: free space on the face is used without moving anything", async () => {
  const def = label([
    { id: "care", rect: rect(2, 4), fontPt: 7, lines: lines(2) }, // ink 10–16.9 mm
    { id: "target", rect: rect(10, 2), fontPt: 6, lines: lines(6) }, // needs 17.8 mm at 6 pt, has 10
  ]);
  const res = await fit(def, 1);
  assert.equal(res.strategy, "kept");
  assert.equal(res.pt, 6);
  const careMm = (page: LayoutPage) => geo.rectMm(page, page.blocks[0].rect!);
  assert.deepEqual(careMm(res.def.pages[0]), careMm(def.pages[0])); // care untouched
  assert.ok(targetOf(res.def.pages[0]).fitHeight, "safety net on");
  assert.equal(res.candidates.today?.pt, 3.25); // what today's cell alone allows
});

test("tier 2: blocks move when keeping can't reach a readable size", async () => {
  const def = label([
    { id: "a", rect: rect(2, 3), fontPt: 7, lines: lines(2), valign: "top" },
    { id: "b", rect: rect(5, 3), fontPt: 7, lines: lines(2), valign: "middle" },
    { id: "c", rect: rect(8, 2), fontPt: 7, lines: lines(2), valign: "bottom" },
    { id: "target", rect: rect(10, 2), fontPt: 6, lines: lines(6) },
  ]);
  const res = await fit(def, 3);
  assert.equal(res.strategy, "moved");
  assert.equal(res.pt, 6);
  assert.ok(res.candidates.moved && res.candidates.moved.moved > 0);
  // order kept: a above b above c above the target
  const rows = res.def.pages[0].blocks.map((b) => b.rect!.row);
  assert.ok(rows[0] < rows[1] && rows[1] < rows[2] && rows[2] < rows[3]);
});

test("tier 3: no fit still returns the most likely layout and the budget", async () => {
  const def = label([
    { id: "a", rect: rect(2, 3), fontPt: 7, lines: lines(2), valign: "top" },
    { id: "b", rect: rect(5, 3), fontPt: 7, lines: lines(2), valign: "middle" },
    { id: "c", rect: rect(8, 2), fontPt: 7, lines: lines(2), valign: "bottom" },
    { id: "target", rect: rect(10, 2), fontPt: 6, lines: lines(40) },
  ]);
  const res = await fit(def, 3);
  assert.equal(res.strategy, "overshoot");
  assert.equal(res.pt, 4);
  assert.ok(res.budget);
  assert.equal(res.budget.users.length, 3);
  assert.ok(res.budget.needAtMm[4] > res.budget.freeMm, "it overshoots, and says by how much");
  assert.equal(targetOf(res.def.pages[0]).valign, "top");
});
