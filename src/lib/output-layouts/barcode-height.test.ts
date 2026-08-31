import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render/tokens modules transitively construct the db
// client at import time, so a dummy DATABASE_URL lets them load (nothing here
// queries; the pool is lazy). Node runs each test file in its own process.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let TOKEN_RE: typeof import("./schema").TOKEN_RE;
let tokensInLine: typeof import("./schema").tokensInLine;
let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let validateTokenRef: typeof import("./token-meta").validateTokenRef;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ TOKEN_RE, tokensInLine, LayoutDefSchema } = await import("./schema"));
  ({ validateTokenRef } = await import("./token-meta"));
  ({ renderLayoutHtml } = await import("./render"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

// ---------------------------------------------------------------------
// Token grammar — {{barcode:ean13:8}} carries the height as group 3 /
// TokenRef.arg2; existing one-arg and no-arg tokens parse unchanged.
// ---------------------------------------------------------------------

test("TOKEN_RE parses the optional numeric height as group 3", () => {
  const m = [..."{{barcode:ean13:8}}".matchAll(new RegExp(TOKEN_RE.source, "g"))];
  assert.equal(m.length, 1);
  assert.equal(m[0][1], "barcode");
  assert.equal(m[0][2], "ean13");
  assert.equal(m[0][3], "8");

  const dec = [..."{{barcode:cartonEan13:12.5}}".matchAll(new RegExp(TOKEN_RE.source, "g"))][0];
  assert.equal(dec[2], "cartonEan13");
  assert.equal(dec[3], "12.5");
});

test("existing tokens parse exactly as before (no arg2)", () => {
  for (const [line, key, arg] of [
    ["{{barcode:ean13}}", "barcode", "ean13"],
    ["{{washSymbols:0}}", "washSymbols", "0"],
    ["{{composition:da}}", "composition", "da"],
    ["{{styleNumber}}", "styleNumber", undefined],
  ] as const) {
    const refs = tokensInLine(line);
    assert.equal(refs.length, 1, line);
    assert.equal(refs[0].key, key, line);
    assert.equal(refs[0].arg, arg, line);
    assert.equal(refs[0].arg2, undefined, line);
  }
});

test("tokensInLine carries arg2", () => {
  const refs = tokensInLine("EAN {{barcode:ean13:6}} done");
  assert.deepEqual(refs, [{ key: "barcode", arg: "ean13", arg2: "6" }]);
});

// ---------------------------------------------------------------------
// Publish validation
// ---------------------------------------------------------------------

test("validateTokenRef accepts a sane barcode height and rejects the rest", () => {
  assert.deepEqual(validateTokenRef("barcode", "ean13", "8"), []);
  assert.deepEqual(validateTokenRef("barcode", "cartonEan", "16"), []);
  assert.deepEqual(validateTokenRef("barcode", "assortEan13", "12.5"), []);
  // Out of the 2–40 mm gate.
  assert.equal(validateTokenRef("barcode", "ean13", "1").length, 1);
  assert.equal(validateTokenRef("barcode", "ean13", "41").length, 1);
  assert.equal(validateTokenRef("barcode", "ean13", "abc").length, 1);
  // No height stays valid — the default sizing.
  assert.deepEqual(validateTokenRef("barcode", "ean13"), []);
  // Non-barcode tokens don't take a second argument.
  assert.equal(validateTokenRef("composition", "da", "5").length, 1);
  assert.equal(validateTokenRef("washSymbols", "0", "5").length, 1);
});

// ---------------------------------------------------------------------
// Render — an explicit height prints the PNG at FIXED physical size
// (bars + digit row), width fitted to the block within the 80–100%
// magnification window; a plain token keeps the font-scaled default.
// ---------------------------------------------------------------------

function defWith(line: string) {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        widthMm: 100,
        heightMm: 60,
        // cols 12 of the 12-col grid → the block spans the full page width,
        // so the page size IS the width available to the barcode.
        blocks: [{ id: "b1", anchor: "top-left", cols: 12, lines: [line] }],
      },
    ],
  });
}

function imgSize(html: string): { h: number; w: number } | null {
  const m = /<img[^>]*style="height: ([0-9.]+)mm; width: ([0-9.]+)mm/.exec(html);
  return m ? { h: Number(m[1]), w: Number(m[2]) } : null;
}

test("{{barcode:ean13:8}} renders at fixed physical size; bars vary with the arg", async () => {
  const style = buildSampleStyleData();
  const s8 = imgSize(await renderLayoutHtml(defWith("{{barcode:ean13:8}}"), style));
  const s20 = imgSize(await renderLayoutHtml(defWith("{{barcode:ean13:20}}"), style));
  const plain = await renderLayoutHtml(defWith("{{barcode:ean13}}"), style);

  assert.ok(s8 && s20, "explicit-height barcodes carry inline width+height");
  // 8 mm bars + the EAN digit row → total a bit over 8 mm, well under 20.
  assert.ok(s8!.h > 8 && s8!.h < 14, `total height for 8mm bars was ${s8!.h}mm`);
  assert.ok(s20!.h > 20 && s20!.h < 26, `total height for 20mm bars was ${s20!.h}mm`);
  assert.ok(s20!.h - s8!.h > 10 && s20!.h - s8!.h < 14, `bar delta was ${s20!.h - s8!.h}mm, expected ≈12mm`);
  // Block (100 mm) is wider than nominal → both print at 100% magnification.
  assert.ok(s8!.w > 36 && s8!.w < 39, `width was ${s8!.w}mm, expected ≈37.5mm nominal`);
  assert.equal(s8!.w, s20!.w, "magnification must not depend on the bar height");
  // No arg → no inline size; the block's font-scaled CSS default applies.
  assert.ok(!/<img[^>]*style="height:/.test(plain), "plain {{barcode:ean13}} must not set an inline size");
});

test("garbage height degrades to the default sizing instead of breaking the print", async () => {
  const style = buildSampleStyleData();
  const html = await renderLayoutHtml(defWith("{{barcode:ean13:99}}"), style);
  assert.ok(html.includes("ol-barcode"), "barcode still renders");
  assert.ok(!/<img[^>]*style="height:/.test(html), "out-of-range height must fall back to CSS default");
});

// ---------------------------------------------------------------------
// Info-area size override — the point of the fixed size: the design
// shrinks, the barcode doesn't.
// ---------------------------------------------------------------------

test("info-area shrink keeps the barcode at fixed physical size (bars exempt from fontScale)", async () => {
  const style = buildSampleStyleData();
  const def = defWith("{{barcode:ean13:8}}");
  const full = imgSize(await renderLayoutHtml(def, style));
  // Banderole-authored (100×60) printed on a mid size → fontScale < 1.
  const shrunk = imgSize(
    await renderLayoutHtml(def, style, { sizeOverrideMm: { widthMm: 50, heightMm: 30 } }),
  );
  assert.ok(full && shrunk);
  assert.equal(shrunk!.h, full!.h, "bar height must not scale with the info-area size");
  // 50 mm block still holds the full 37.5 mm symbol at 100%.
  assert.equal(shrunk!.w, full!.w, "magnification unchanged while the block still fits 100%");
});

test("narrow block squeezes magnification to fit", async () => {
  const style = buildSampleStyleData();
  const def = defWith("{{barcode:ean13:8}}");
  // Topcard-license-ish 32 mm, nominal ~37.5 mm → width fits the block
  // exactly (≈85% magnification), bar height untouched.
  const fitted = imgSize(
    await renderLayoutHtml(def, style, { sizeOverrideMm: { widthMm: 32, heightMm: 24 } }),
  );
  assert.ok(fitted, "fitted barcode still renders as an img");
  assert.ok(Math.abs(fitted!.w - 32) < 0.05, `width was ${fitted!.w}mm, expected 32mm (block-fitted)`);
  assert.ok(fitted!.h > 8 && fitted!.h < 14, "bar height stays fixed while width fits");
});

test("block narrower than the 80% GS1 floor still renders (no magnification floor enforced)", async () => {
  const style = buildSampleStyleData();
  const def = defWith("{{barcode:ean13:8}}");
  // Hangtag/Socktag License (27.5×20 mm): 27.5 mm < the ~30 mm GS1 floor.
  // By deliberate choice (Niels, 2026-08-31) this squeezes and prints
  // instead of chipping — no scannability guardrail on this path.
  const html = await renderLayoutHtml(def, style, { sizeOverrideMm: { widthMm: 27.5, heightMm: 20 } });
  assert.ok(!html.includes('class="barcode-missing"'), "renders the symbol instead of a placeholder chip");
  const size = imgSize(html);
  assert.ok(size, "barcode image renders");
  assert.ok(Math.abs(size!.w - 27.5) < 0.05, `width was ${size!.w}mm, expected 27.5mm (block-fitted)`);
});
