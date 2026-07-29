import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load (nothing here queries).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;
let normalizeFileNamePresets: typeof import("../settings/app-settings").normalizeFileNamePresets;

before(async () => {
  ({ LayoutDefSchema } = await import("./schema"));
  ({ renderLayoutHtml } = await import("./render"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
  ({ normalizeFileNamePresets } = await import("../settings/app-settings"));
});

function defWith(pageBorder?: { widthMm: number; color: string; insetMm: number }) {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 100,
        heightMm: 60,
        ...(pageBorder ? { pageBorder } : {}),
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

// ---------------------------------------------------------------------
// Page border — the whole-page frame, replacing the "empty full-page
// block" workaround.
// ---------------------------------------------------------------------

test("no pageBorder ⇒ no frame in the output (existing layouts unchanged)", async () => {
  const html = await renderLayoutHtml(defWith(), buildSampleStyleData());
  assert.ok(!html.includes(`class="ol-page-border"`), "layouts without a border must not gain one");
});

test("pageBorder renders one frame with the authored width, colour and inset", async () => {
  const html = await renderLayoutHtml(
    defWith({ widthMm: 0.5, color: "#1a1a1a", insetMm: 2 }),
    buildSampleStyleData(),
  );
  const frames = [...html.matchAll(/class="ol-page-border"[^>]*/g)];
  assert.equal(frames.length, 1, "exactly one frame per page");
  assert.ok(frames[0][0].includes("inset: 2mm"), frames[0][0]);
  assert.ok(frames[0][0].includes("border: 0.5mm solid #1a1a1a"), frames[0][0]);
});

test("the frame is painted before the blocks so content prints on top", async () => {
  const html = await renderLayoutHtml(
    defWith({ widthMm: 0.3, color: "#000000", insetMm: 0 }),
    buildSampleStyleData(),
  );
  assert.ok(html.indexOf(`class="ol-page-border"`) < html.indexOf(`class="ol-block`), "border must precede the blocks");
});

test("schema rejects an out-of-range width and a non-hex colour", () => {
  assert.throws(() => defWith({ widthMm: 0, color: "#000000", insetMm: 0 }));
  assert.throws(() => defWith({ widthMm: 0.3, color: "black", insetMm: 0 }));
});

// ---------------------------------------------------------------------
// File-name presets — a hand-edited / stale AppSetting row must never
// break the builder, so normalization drops rather than throws.
// ---------------------------------------------------------------------

test("normalizeFileNamePresets keeps good rows, drops junk, de-dupes ids", () => {
  const out = normalizeFileNamePresets([
    { id: "a", label: "Price sticker", pattern: "{{styleNumber}}-{{colourName}}-{{size}}-Price Sticker" },
    { id: "a", label: "duplicate id", pattern: "x" },
    { id: "b", pattern: "  {{styleNumber}}-Carton Marking  " },
    { id: "", pattern: "no id" },
    { id: "c", pattern: "" },
    "nonsense",
    null,
  ]);
  assert.deepEqual(out.map((p) => p.id), ["a", "b"]);
  assert.equal(out[0].label, "Price sticker");
  // No label ⇒ the pattern doubles as the label, trimmed.
  assert.equal(out[1].pattern, "{{styleNumber}}-Carton Marking");
  assert.equal(out[1].label, "{{styleNumber}}-Carton Marking");
});

test("normalizeFileNamePresets tolerates a non-array value", () => {
  assert.deepEqual(normalizeFileNamePresets(undefined), []);
  assert.deepEqual(normalizeFileNamePresets({ presets: [] }), []);
});
