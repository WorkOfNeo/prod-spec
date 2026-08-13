import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load (nothing here queries).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let effectiveBorderSides: typeof import("./schema").effectiveBorderSides;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ LayoutDefSchema, effectiveBorderSides } = await import("./schema"));
  ({ renderLayoutHtml } = await import("./render"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

type Sides = { top: boolean; right: boolean; bottom: boolean; left: boolean };

// One 100 × 60 page, one bordered block, optionally a page frame — enough to
// read both borders straight out of the emitted style attributes.
function defWith(opts: {
  blockSides?: Sides;
  pageSides?: Sides;
  pageBorder?: boolean;
  borderWidthMm?: number;
}) {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 100,
        heightMm: 60,
        ...(opts.pageBorder || opts.pageSides
          ? {
              pageBorder: {
                widthMm: 0.4,
                color: "#000000",
                insetMm: 0,
                ...(opts.pageSides ? { sides: opts.pageSides } : {}),
              },
            }
          : {}),
        blocks: [
          {
            id: "b1",
            rect: { col: 0, row: 0, colSpan: 6, rowSpan: 3 },
            fontPt: 9,
            border: {
              widthMm: opts.borderWidthMm ?? 0.5,
              color: "#1a1a1a",
              pad: { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 },
              ...(opts.blockSides ? { sides: opts.blockSides } : {}),
            },
            lines: ["{{styleNumber}}"],
          },
        ],
      },
    ],
  });
}

function blockStyle(html: string): string {
  return html.match(/class="ol-block ol-rect"[^>]*/)![0];
}
function frameStyle(html: string): string {
  return html.match(/class="ol-page-border"[^>]*/)![0];
}

// ---------------------------------------------------------------------
// The compatibility contract: every border authored before `sides` existed
// — which is every border in the field — must still print all round, and
// must still emit the SAME css it always did.
// ---------------------------------------------------------------------

test("no authored sides ⇒ all four (the shape every existing layout has)", () => {
  assert.deepEqual(effectiveBorderSides(undefined), { top: true, right: true, bottom: true, left: true });
  assert.deepEqual(effectiveBorderSides({}), { top: true, right: true, bottom: true, left: true });
  assert.deepEqual(effectiveBorderSides({ sides: { top: false, right: true, bottom: true, left: true } }), {
    top: false,
    right: true,
    bottom: true,
    left: true,
  });
});

test("a border with no sides authored still emits the plain `border:` shorthand", async () => {
  const html = await renderLayoutHtml(defWith({ pageBorder: true }), buildSampleStyleData());
  assert.ok(blockStyle(html).includes("border: 0.500mm solid #1a1a1a;"), blockStyle(html));
  assert.ok(!blockStyle(html).includes("border-top"), "must not split into per-side rules");
  assert.ok(frameStyle(html).includes("border: 0.4mm solid #000000;"), frameStyle(html));
});

test("sides set to all four is identical to not setting them at all", async () => {
  const all = { top: true, right: true, bottom: true, left: true };
  const authored = await renderLayoutHtml(
    defWith({ blockSides: all, pageSides: all }),
    buildSampleStyleData(),
  );
  const absent = await renderLayoutHtml(defWith({ pageBorder: true }), buildSampleStyleData());
  assert.equal(blockStyle(authored), blockStyle(absent));
  assert.equal(frameStyle(authored), frameStyle(absent));
});

// ---------------------------------------------------------------------
// Per-side: only the authored edges are drawn.
// ---------------------------------------------------------------------

test("a bottom-only block border draws one rule and nothing else", async () => {
  const html = await renderLayoutHtml(
    defWith({ blockSides: { top: false, right: false, bottom: true, left: false } }),
    buildSampleStyleData(),
  );
  const style = blockStyle(html);
  assert.ok(style.includes("border-bottom: 0.500mm solid #1a1a1a;"), style);
  for (const side of ["border-top", "border-right", "border-left"]) {
    assert.ok(!style.includes(side), `${side} must be absent: ${style}`);
  }
  // No leftover shorthand that would re-draw all four.
  assert.ok(!/border: /.test(style), style);
});

test("an L (top + left) draws exactly those two edges", async () => {
  const html = await renderLayoutHtml(
    defWith({ blockSides: { top: true, right: false, bottom: false, left: true } }),
    buildSampleStyleData(),
  );
  const style = blockStyle(html);
  assert.ok(style.includes("border-top: 0.500mm solid #1a1a1a;"), style);
  assert.ok(style.includes("border-left: 0.500mm solid #1a1a1a;"), style);
  assert.ok(!style.includes("border-right"), style);
  assert.ok(!style.includes("border-bottom"), style);
});

test("the page frame can be a single rule too, and keeps its inset", async () => {
  const html = await renderLayoutHtml(
    defWith({ pageSides: { top: false, right: false, bottom: true, left: false } }),
    buildSampleStyleData(),
  );
  const style = frameStyle(html);
  assert.ok(style.includes("inset: 0mm"), style);
  assert.ok(style.includes("border-bottom: 0.4mm solid #000000;"), style);
  assert.ok(!style.includes("border-top"), style);
});

test("a partial frame still curves with a rounded die", async () => {
  const def = LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 100,
        heightMm: 60,
        cornerRadiusMm: 5,
        pageBorder: {
          widthMm: 0.4,
          color: "#000000",
          insetMm: 2,
          sides: { top: true, right: true, bottom: false, left: false },
        },
        blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 6, rowSpan: 3 }, fontPt: 9, lines: ["x"] }],
      },
    ],
  });
  const style = frameStyle(await renderLayoutHtml(def, buildSampleStyleData()));
  // 5 mm die pulled in 2 mm ⇒ a 3 mm frame corner, same as a full frame.
  assert.ok(style.includes("border-radius: 3mm"), style);
  assert.ok(style.includes("border-top: 0.4mm solid #000000;"), style);
  assert.ok(!style.includes("border-bottom"), style);
});

// ---------------------------------------------------------------------
// Dropping a vertical rule gives its width back to the content: the block
// is box-sizing: border-box, so the text width the fixed-size barcode and
// the fit script measure against must count only the rules that print.
// ---------------------------------------------------------------------

test("a horizontal-only border gives its width back to the content", async () => {
  // A fixed-size barcode auto-fits the block's CONTENT width, so it reads
  // that number back out of the render. 100 mm page ÷ 12 cols × 4 = 33.33 mm
  // cell: a 1 mm border all round leaves 31.33 mm, top+bottom only leaves the
  // full 33.33 mm — 2 mm the vertical rules are no longer taking.
  async function barcodeWidth(sides?: Sides) {
    const def = LayoutDefSchema.parse({
      pages: [
        {
          id: "p1",
          title: "",
          widthMm: 100,
          heightMm: 60,
          blocks: [
            {
              id: "b1",
              rect: { col: 0, row: 0, colSpan: 4, rowSpan: 3 },
              fontPt: 9,
              border: {
                widthMm: 1,
                color: "#000000",
                pad: { topMm: 0, rightMm: 0, bottomMm: 0, leftMm: 0 },
                ...(sides ? { sides } : {}),
              },
              lines: ["{{barcode:ean13:12}}"],
            },
          ],
        },
      ],
    });
    const html = await renderLayoutHtml(def, buildSampleStyleData());
    // (the class name also appears in the stylesheet — match the element)
    assert.ok(!html.includes(`class="barcode-missing"`), "fixture must stay above the scannable floor");
    return { width: Number(/width: ([\d.]+)mm; max-width: none/.exec(html)![1]), html };
  }
  const full = await barcodeWidth();
  const horiz = await barcodeWidth({ top: true, right: false, bottom: true, left: false });
  assert.equal(Number((horiz.width - full.width).toFixed(3)), 2, `${full.width} → ${horiz.width}`);
  assert.ok(blockStyle(horiz.html).includes("border-top: 1.000mm"), blockStyle(horiz.html));
  assert.ok(!blockStyle(horiz.html).includes("border-left"), blockStyle(horiz.html));
});

// ---------------------------------------------------------------------
// Schema bounds.
// ---------------------------------------------------------------------

test("sides must be booleans", () => {
  assert.throws(() =>
    LayoutDefSchema.parse({
      pages: [
        {
          id: "p1",
          title: "",
          widthMm: 100,
          heightMm: 60,
          pageBorder: { widthMm: 0.4, color: "#000000", insetMm: 0, sides: { top: "yes" } },
          blocks: [],
        },
      ],
    }),
  );
});

test("a partial `sides` object fills the rest in as printing", () => {
  const def = LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 100,
        heightMm: 60,
        pageBorder: { widthMm: 0.4, color: "#000000", insetMm: 0, sides: { bottom: false } },
        blocks: [],
      },
    ],
  });
  assert.deepEqual(def.pages[0].pageBorder!.sides, {
    top: true,
    right: true,
    bottom: false,
    left: true,
  });
});
