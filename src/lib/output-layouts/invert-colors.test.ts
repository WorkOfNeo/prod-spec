import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load (nothing here queries).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let invertColors: typeof import("./schema").invertColors;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ LayoutDefSchema, invertColors } = await import("./schema"));
  ({ renderLayoutHtml } = await import("./render"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

function defWith(block: Record<string, unknown>) {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 100,
        heightMm: 60,
        blocks: [
          {
            id: "b1",
            rect: { col: 0, row: 0, colSpan: 6, rowSpan: 3 },
            fontPt: 9,
            lines: ["{{styleNumber}}"],
            ...block,
          },
        ],
      },
    ],
  });
}

// The one rendered block's class list and inline style attribute. Read off
// the element itself — the document stylesheet mentions ol-binvert whether or
// not any block uses it.
function renderedBlock(html: string): { cls: string; style: string } {
  const m = /<div class="(ol-block[^"]*)" style="([^"]*)"/.exec(html);
  assert.ok(m, "expected a rendered block");
  return { cls: m[1], style: m[2] };
}

function blockStyle(html: string): string {
  return renderedBlock(html).style;
}

// ---------------------------------------------------------------------
// Inverted blocks — authorable colours, with the historic black/white
// pair as the fallback so nothing already published changes.
// ---------------------------------------------------------------------

test("invert with no authored colours still prints black-on-white-text", async () => {
  const html = await renderLayoutHtml(defWith({ invert: true }), buildSampleStyleData());
  const { cls, style } = renderedBlock(html);
  assert.ok(style.includes("background: #000000"), style);
  assert.ok(style.includes("color: #ffffff"), style);
  // The class stays — the barcode white-chip rule hangs off it.
  assert.ok(cls.includes("ol-binvert"), cls);
});

test("authored hex pair prints instead of the default", async () => {
  const html = await renderLayoutHtml(
    defWith({ invert: true, invertBg: "#1a4d2e", invertText: "#f5e6c8" }),
    buildSampleStyleData(),
  );
  const style = blockStyle(html);
  assert.ok(style.includes("background: #1a4d2e"), style);
  assert.ok(style.includes("color: #f5e6c8"), style);
});

test("each colour falls back on its own — text-only keeps the black box", async () => {
  const html = await renderLayoutHtml(
    defWith({ invert: true, invertText: "#ff0000" }),
    buildSampleStyleData(),
  );
  const style = blockStyle(html);
  assert.ok(style.includes("background: #000000"), style);
  assert.ok(style.includes("color: #ff0000"), style);
});

test("a block that isn't inverted gets no colours at all", async () => {
  const html = await renderLayoutHtml(
    // Colours authored but invert off — nothing is painted, so turning
    // invert back on restores exactly what was picked.
    defWith({ invert: false, invertBg: "#123456", invertText: "#abcdef" }),
    buildSampleStyleData(),
  );
  const { cls, style } = renderedBlock(html);
  assert.ok(!style.includes("background:"), style);
  assert.ok(!style.includes("#123456"), style);
  assert.ok(!cls.includes("ol-binvert"), cls);
});

test("invertColors is the shared fallback the builder and renderer both read", () => {
  assert.deepEqual(invertColors({}), { bg: "#000000", text: "#ffffff" });
  assert.deepEqual(invertColors({ invertBg: "#111111" }), { bg: "#111111", text: "#ffffff" });
  assert.deepEqual(invertColors({ invertText: "#eeeeee" }), { bg: "#000000", text: "#eeeeee" });
  assert.deepEqual(invertColors({ invertBg: "#abc", invertText: "#def" }), { bg: "#abc", text: "#def" });
});

test("schema rejects a non-hex invert colour", () => {
  assert.throws(() => defWith({ invert: true, invertBg: "black" }));
  assert.throws(() => defWith({ invert: true, invertText: "rgb(255,0,0)" }));
  assert.throws(() => defWith({ invert: true, invertBg: "#12345" }));
  // Both hex shapes the rest of the schema accepts stay valid here.
  assert.doesNotThrow(() => defWith({ invert: true, invertBg: "#abc", invertText: "#1A1A1A" }));
});
