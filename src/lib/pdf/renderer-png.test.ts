import { test, after } from "node:test";
import assert from "node:assert/strict";

// renderHtmlPng launches Chromium. No browser is bundled with the install, so
// this only runs where one is pointed at:
//   PUPPETEER_EXECUTABLE_PATH=/path/to/chrome node --import tsx --test src/lib/pdf/renderer-png.test.ts
const browserPath = process.env.PUPPETEER_EXECUTABLE_PATH;
const skip = browserPath ? false : "PUPPETEER_EXECUTABLE_PATH is not set (no Chromium to launch)";

const PX_PER_MM = 96 / 25.4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Two 50×30 mm pages: the first solid black, the second solid red. A proof is
// the FIRST page only, so no red may reach the picture.
const TWO_PAGES = `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  @page { size: 50mm 30mm; margin: 0; }
  html, body { margin: 0; padding: 0; }
  .p { width: 50mm; height: 30mm; page-break-after: always; }
</style></head>
<body><div class="p" style="background:#000"></div><div class="p" style="background:#f00"></div></body></html>`;

function pngSize(png: Buffer): { width: number; height: number } {
  // IHDR is the first chunk: width and height are big-endian at 16 and 20.
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

after(async () => {
  if (!browserPath) return;
  const { closeBrowser } = await import("./renderer");
  await closeBrowser();
});

test("renderHtmlPng: a PNG of the first page at mm × 96 dpi × scale", { skip }, async () => {
  const { renderHtmlPng } = await import("./renderer");
  const png = await renderHtmlPng({ html: TWO_PAGES, widthMm: 50, heightMm: 30 });
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), "PNG signature");

  const { width, height } = pngSize(png);
  // Default scale 3: 50 mm → ~567 px, 30 mm → ~340 px (±1 for rounding).
  assert.ok(Math.abs(width - 50 * PX_PER_MM * 3) <= 1.5, `width ${width}`);
  assert.ok(Math.abs(height - 30 * PX_PER_MM * 3) <= 1.5, `height ${height}`);

  // Clipped to the page box: black throughout, the red second page excluded.
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const g = canvas.getContext("2d");
  g.drawImage(img, 0, 0);
  for (const [x, y] of [
    [Math.floor(width / 2), Math.floor(height / 2)],
    [1, height - 2],
    [width - 2, height - 2],
  ]) {
    const [r, gr, b] = g.getImageData(x, y, 1, 1).data;
    assert.ok(r < 40 && gr < 40 && b < 40, `pixel ${x},${y} is ${r},${gr},${b}, expected black`);
  }
});

test("renderHtmlPng: scale sets the device pixel ratio", { skip }, async () => {
  const { renderHtmlPng } = await import("./renderer");
  const png = await renderHtmlPng({ html: TWO_PAGES, widthMm: 50, heightMm: 30, scale: 1 });
  const { width, height } = pngSize(png);
  assert.ok(Math.abs(width - 50 * PX_PER_MM) <= 1.5, `width ${width}`);
  assert.ok(Math.abs(height - 30 * PX_PER_MM) <= 1.5, `height ${height}`);
});

test("renderHtmlPng: refuses an empty page box", { skip }, async () => {
  const { renderHtmlPng } = await import("./renderer");
  await assert.rejects(renderHtmlPng({ html: TWO_PAGES, widthMm: 0, heightMm: 30 }), /invalid page box/);
});
