import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load (nothing here queries).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ LayoutDefSchema } = await import("./schema"));
  ({ renderLayoutHtml } = await import("./render"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

function defWith(
  centerHole?: { diameterMm: number; edge: "top" | "bottom"; offsetMm: number },
  page: Record<string, unknown> = {},
) {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 100,
        heightMm: 60,
        ...(centerHole ? { centerHole } : {}),
        ...page,
        blocks: [
          {
            id: "b1",
            rect: { col: 0, row: 0, colSpan: 6, rowSpan: 3 },
            fontPt: 9,
            lines: ["{{styleNumber}}"],
          },
        ],
      },
    ],
  });
}

function holes(html: string): string[] {
  return [...html.matchAll(/<div class="ol-guide ol-hole[^>]*>/g)].map((m) => m[0]);
}

// ---------------------------------------------------------------------
// Centre hole — the die-cut hang hole, drawn as a print guide.
// ---------------------------------------------------------------------

test("no centerHole ⇒ no hole in the output (existing layouts unchanged)", async () => {
  const html = await renderLayoutHtml(defWith(), buildSampleStyleData());
  assert.equal(holes(html).length, 0, "layouts without a hole must not gain one");
});

test("a top hole renders once, sized and offset from the top edge", async () => {
  const html = await renderLayoutHtml(
    defWith({ diameterMm: 6, edge: "top", offsetMm: 8 }),
    buildSampleStyleData(),
  );
  const found = holes(html);
  assert.equal(found.length, 1, "exactly one hole per page");
  assert.ok(found[0].includes("ol-hole-top"), found[0]);
  assert.ok(found[0].includes("top: 8mm"), found[0]);
  assert.ok(found[0].includes("width: 6mm"), found[0]);
  assert.ok(found[0].includes("height: 6mm"), found[0]);
});

test("a bottom hole is measured from the bottom edge", async () => {
  const html = await renderLayoutHtml(
    defWith({ diameterMm: 4.5, edge: "bottom", offsetMm: 10 }),
    buildSampleStyleData(),
  );
  const found = holes(html);
  assert.equal(found.length, 1);
  assert.ok(found[0].includes("ol-hole-bottom"), found[0]);
  assert.ok(found[0].includes("bottom: 10mm"), found[0]);
  assert.ok(found[0].includes("width: 4.5mm"), found[0]);
});

test("the hole is drawn after the blocks, like the other guides", async () => {
  const html = await renderLayoutHtml(
    defWith({ diameterMm: 5, edge: "top", offsetMm: 8 }),
    buildSampleStyleData(),
  );
  assert.ok(
    html.indexOf(`class="ol-block`) < html.indexOf(`class="ol-guide ol-hole`),
    "guides sit on top of the content",
  );
});

test("the hole is an outline only — nothing is knocked out of the design", async () => {
  const html = await renderLayoutHtml(
    defWith({ diameterMm: 5, edge: "top", offsetMm: 8 }),
    buildSampleStyleData(),
  );
  const rule = /\.ol-hole \{([^}]*)\}/.exec(html);
  assert.ok(rule, "expected the .ol-hole rule");
  assert.ok(!/background/.test(rule[1]), rule[1]);
  assert.ok(/border-radius: 50%/.test(rule[1]), rule[1]);
});

test("a hole is chrome, not content — it can't keep an empty page alive", async () => {
  // Same rule the page border and sewing/fold guides follow: a page whose
  // only block resolves to nothing is still empty, hole or not.
  const def = LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "Front",
        widthMm: 35,
        heightMm: 45,
        blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 6, rowSpan: 6 }, fontPt: 9, lines: ["{{styleNumber}}"] }],
      },
      {
        id: "p2",
        title: "Cert",
        widthMm: 35,
        heightMm: 45,
        omitWhenEmpty: true,
        centerHole: { diameterMm: 5, edge: "top", offsetMm: 8 },
        blocks: [{ id: "b2", rect: { col: 0, row: 0, colSpan: 6, rowSpan: 6 }, fontPt: 9, lines: ["{{cert:oekotex}}"] }],
      },
    ],
  });
  const style = { ...buildSampleStyleData(), certificates: [] };
  const html = await renderLayoutHtml(def, style, { mode: "production" });
  const pages = [...html.matchAll(/class="ol-page ol-page-\d+"/g)].length;
  assert.equal(pages, 1, "the hole must not keep the page");
  assert.equal(holes(html).length, 0, "the dropped page's hole goes with it");
});

test("schema rejects an out-of-range diameter and an unknown edge", () => {
  assert.throws(() => defWith({ diameterMm: 0, edge: "top", offsetMm: 8 }));
  assert.throws(() => defWith({ diameterMm: 200, edge: "top", offsetMm: 8 }));
  assert.throws(() =>
    defWith({ diameterMm: 5, edge: "left" as unknown as "top", offsetMm: 8 }),
  );
  assert.throws(() => defWith({ diameterMm: 5, edge: "top", offsetMm: -1 }));
});
