// Temporary smoke test for the Output Builder renderer — run with:
//   npx tsx --env-file=.env scripts/ol-smoke-test.ts
// Verifies (no DB needed): schema parse, token resolution, anchor blocks,
// barcode rendering, preview missing-markers, and that CSS named pages
// produce a PDF with two differently-sized pages.
import { writeFileSync } from "node:fs";
import { LayoutDefSchema } from "@/lib/output-layouts/schema";
import { renderLayoutHtml } from "@/lib/output-layouts/render";
import { unresolvedTokens, staticRequiredColumns } from "@/lib/output-layouts/tokens";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";
import { renderPdf, closeBrowser } from "@/lib/pdf/renderer";
import { countPlaceholderMarkers } from "@/lib/pdf/placeholders";

const DEF = LayoutDefSchema.parse({
  pages: [
    {
      id: "p1",
      title: "Long side",
      widthMm: 150,
      heightMm: 75,
      blocks: [
        { anchor: "top-left", cols: 5, fontPt: 11.5, bold: true, lines: ["{{customerName}}"] },
        { anchor: "top-right", cols: 5, lines: ["{{barcode:cartonEan}}"] },
        {
          anchor: "bottom-left",
          cols: 7,
          fontPt: 10.5,
          bold: true,
          lines: [
            "Pcs. Per master:  {{qtyPerCarton}}",
            "Total no. Master Cartons:  ",
            "Order no. :  {{orderNo}}",
            "Article:  {{description}}",
            "Weight:  ",
          ],
        },
        { anchor: "bottom-right", cols: 4, fontPt: 8, lines: ["Made in {{countryOfOrigin}}"] },
      ],
    },
    {
      id: "p2",
      title: "Short side",
      widthMm: 110,
      heightMm: 75,
      blocks: [
        { anchor: "top-left", cols: 6, fontPt: 11.5, bold: true, lines: ["{{customerName}}"] },
        { anchor: "bottom-left", cols: 8, fontPt: 10.5, lines: ["Order no. :  {{orderNo}}", "{{careInstructions:xx}}"] },
      ],
    },
  ],
});

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

async function main() {
  const style = buildSampleStyleData();

  console.log("required columns:", staticRequiredColumns(DEF).join(", "));

  // --- production render ---
  const prod = await renderLayoutHtml(DEF, style, { mode: "production", title: "smoke" });
  assert(prod.includes("@page olp0 { size: 150mm 75mm"), "named page olp0 (150×75) present");
  assert(prod.includes("@page olp1 { size: 110mm 75mm"), "named page olp1 (110×75) present");
  assert(prod.includes('class="ol-page ol-page-0"') && prod.includes('class="ol-page ol-page-1"'), "two page divs");
  assert(prod.includes(style.customerName), "customerName resolved");
  assert(/data:image\/png;base64/.test(prod) || prod.includes("barcode-missing"), "barcode rendered (or honest gap)");
  // careInstructions:xx has no value → token-only line must be DROPPED in production
  assert(!prod.includes("careInstructions"), "empty token-only line dropped in production");

  // --- preview render: gaps visible ---
  const prev = await renderLayoutHtml(DEF, style, { mode: "preview" });
  assert(prev.includes("ol-miss") || unresolvedTokens(DEF, style).length === 0, "preview shows missing markers when unresolved");
  console.log("unresolved on sample:", unresolvedTokens(DEF, style).join(", ") || "(none)");
  console.log("placeholderCount(production):", countPlaceholderMarkers(prod));

  // --- PDF: two pages, two sizes ---
  const pdf = await renderPdf({ html: prod });
  writeFileSync("/tmp/ol-smoke.pdf", pdf);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf) }).promise;
  assert(doc.numPages === 2, `pdf has 2 pages (got ${doc.numPages})`);
  const toMm = (pt: number) => (pt / 72) * 25.4;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    console.log(`page ${i}: ${toMm(vp.width).toFixed(1)} × ${toMm(vp.height).toFixed(1)} mm`);
  }
  const p1 = (await doc.getPage(1)).getViewport({ scale: 1 });
  const p2 = (await doc.getPage(2)).getViewport({ scale: 1 });
  assert(Math.abs(toMm(p1.width) - 150) < 1.5 && Math.abs(toMm(p1.height) - 75) < 1.5, "page 1 is 150×75 mm");
  assert(Math.abs(toMm(p2.width) - 110) < 1.5 && Math.abs(toMm(p2.height) - 75) < 1.5, "page 2 is 110×75 mm (named pages honoured)");

  await closeBrowser();
  console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED — /tmp/ol-smoke.pdf written");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
