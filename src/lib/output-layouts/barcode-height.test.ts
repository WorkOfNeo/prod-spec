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
// Render — an explicit height prints the PNG at true physical size
// (bars + digit row), a plain token keeps the font-scaled default.
// ---------------------------------------------------------------------

function defWith(line: string) {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        widthMm: 100,
        heightMm: 60,
        blocks: [{ id: "b1", anchor: "top-left", lines: [line] }],
      },
    ],
  });
}

test("{{barcode:ean13:8}} renders with an explicit ~11mm total img height; bars vary with the arg", async () => {
  const style = buildSampleStyleData();
  const html8 = await renderLayoutHtml(defWith("{{barcode:ean13:8}}"), style);
  const html20 = await renderLayoutHtml(defWith("{{barcode:ean13:20}}"), style);
  const plain = await renderLayoutHtml(defWith("{{barcode:ean13}}"), style);

  const h8 = Number(/<img[^>]*style="height: ([0-9.]+)mm"/.exec(html8)?.[1]);
  const h20 = Number(/<img[^>]*style="height: ([0-9.]+)mm"/.exec(html20)?.[1]);
  // 8 mm bars + the EAN digit row → total a bit over 8 mm, well under 20.
  assert.ok(h8 > 8 && h8 < 14, `total height for 8mm bars was ${h8}mm`);
  assert.ok(h20 > 20 && h20 < 26, `total height for 20mm bars was ${h20}mm`);
  assert.ok(h20 - h8 > 10 && h20 - h8 < 14, `bar delta was ${h20 - h8}mm, expected ≈12mm`);
  // No arg → no inline height; the block's font-scaled CSS default applies.
  assert.ok(!/<img[^>]*style="height:/.test(plain), "plain {{barcode:ean13}} must not set an inline height");
});

test("garbage height degrades to the default sizing instead of breaking the print", async () => {
  const style = buildSampleStyleData();
  const html = await renderLayoutHtml(defWith("{{barcode:ean13:99}}"), style);
  assert.ok(html.includes("ol-barcode"), "barcode still renders");
  assert.ok(!/<img[^>]*style="height:/.test(html), "out-of-range height must fall back to CSS default");
});
