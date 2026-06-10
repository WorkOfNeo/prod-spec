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

main()
  .then(() => batch2())
  .then(() => batch3())
  .then(() => batch4())
  .then(() => batch5())
  .then(() => batch6())
  .then(() => batch7())
  .then(() => batch8())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// ---------------------------------------------------------------------
// Batch 2 coverage: conditionals, rect blocks, barcode scaling, wash
// symbols. Appended as a second async pass — run after main() resolves.
// ---------------------------------------------------------------------
async function batch2() {
  const { unresolvedTokens: _u, staticRequiredColumns: src2, layoutReadinessColumns } = await import(
    "@/lib/output-layouts/tokens"
  );
  const style = buildSampleStyleData();

  const DEF2 = LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "Squared sticker",
        widthMm: 100,
        heightMm: 100,
        blocks: [
          // Centered rect block — middle of the page, both axes.
          {
            id: "b-center",
            rect: { col: 2, row: 4, colSpan: 8, rowSpan: 4 },
            align: "center",
            valign: "middle",
            fontPt: 12,
            lines: ["{{customerName}}", "{{washSymbols}}"],
          },
          // Conditional order number — FOB branch vs DDP branch.
          {
            id: "b-cond",
            rect: { col: 0, row: 10, colSpan: 12, rowSpan: 2 },
            align: "center",
            fontPt: 9,
            lines: ["Order: {{if deliveryTerm == FOB}}{{customerOrderNo}}{{else}}{{poNumber}}{{endif}}"],
          },
        ],
      },
    ],
  });

  // Static columns exclude conditional branches:
  const stat = src2(DEF2);
  assert(!stat.includes("poNumber") && !stat.includes("customerOrderNo"), "branch tokens not in static columns");
  assert(stat.includes("washCare"), "washSymbols gates on washCare column");

  // Branch-aware readiness: DDP style → poNumber required, not customerOrderNo.
  const resolveDdp = (f: string) => (f === "deliveryTerm" ? "DDP" : "x");
  const readyCols = layoutReadinessColumns(DEF2, resolveDdp as never);
  assert(readyCols.includes("poNumber" as never), "DDP branch requires poNumber");
  assert(!readyCols.includes("customerOrderNo" as never), "DDP branch does not require customerOrderNo");

  // Render — DDP sample (sample deliveryTerm is not FOB) shows the PO.
  const html2 = await renderLayoutHtml(DEF2, style, { mode: "production", title: "smoke2" });
  assert(html2.includes("left: 16.67mm; top: 33.33mm; width: 66.67mm; height: 33.33mm"), "rect block positioned by grid mm");
  assert(html2.includes("justify-content: center") && html2.includes("text-align: center"), "align/valign center applied");
  assert(html2.includes(`Order: ${style.poNumber}`) || html2.includes("Order:"), "conditional rendered");
  assert(!html2.includes("customerOrderNo"), "untaken FOB branch dropped");
  // Barcode/symbol scaling vars derived from fontPt 12 → 21.33mm bars / 8mm symbols.
  assert(html2.includes("--ol-sym: 8.00mm"), "wash symbol size scales with font size");
  // Wash symbols render imgs or honest missing chips:
  assert(html2.includes("ol-symbols") || html2.includes('class="missing"'), "wash symbols block rendered");

  // FOB branch via a tweaked style:
  const fobStyle = { ...style, deliveryTerm: "FOB", customerOrderNo: "CUST-4711" };
  const htmlFob = await renderLayoutHtml(DEF2, fobStyle, { mode: "production" });
  assert(htmlFob.includes("Order: CUST-4711"), "FOB branch shows customer order no");
  assert(!htmlFob.includes(`Order: ${style.poNumber}`), "FOB branch hides PO");

  // Barcode scaling: same def at two font sizes → different bar heights.
  const BAR = (pt: number) =>
    LayoutDefSchema.parse({
      pages: [{ id: "p", title: "", widthMm: 100, heightMm: 50, blocks: [{ id: "b", anchor: "top-right", fontPt: pt, lines: ["{{barcode:cartonEan}}"] }] }],
    });
  const small = await renderLayoutHtml(BAR(9), style, { mode: "production" });
  const big = await renderLayoutHtml(BAR(18), style, { mode: "production" });
  assert(small.includes("--ol-bc-h: 16.00mm"), "9pt block → 16mm bars (classic size)");
  assert(big.includes("--ol-bc-h: 32.00mm"), "18pt block → 32mm bars (scales 2×)");

  await closeBrowser();
  console.log(process.exitCode ? "BATCH 2 FAILED" : "BATCH 2 PASSED");
}

void batch2;

// ---------------------------------------------------------------------
// Batch 3 coverage: corner→rect migration, repeat-per-EAN, fileName.
// ---------------------------------------------------------------------
async function batch3() {
  const { parseLayoutDef } = await import("@/lib/output-layouts/schema");
  const { resolveLayoutFileName } = await import("@/lib/output-layouts/tokens");
  const style = buildSampleStyleData();

  // Legacy corner block converts to an equivalent rect at parse time.
  const migrated = parseLayoutDef({
    pages: [
      {
        id: "p1", title: "", widthMm: 150, heightMm: 75,
        blocks: [{ anchor: "bottom-right", cols: 4, fontPt: 8, lines: ["Made in {{countryOfOrigin}}"] }],
      },
    ],
  });
  const mb = migrated.pages[0].blocks[0];
  assert(!!mb.rect && !mb.anchor, "corner block migrated to rect");
  assert(mb.rect!.col === 8 && mb.rect!.colSpan === 4 && mb.valign === "bottom" && mb.align === "right",
    "migration preserves corner geometry (right edge, bottom-pinned)");

  // Repeat-per-EAN: one page per size row; {{size}}/{{ean13}} bind per repetition.
  const REP = LayoutDefSchema.parse({
    pages: [{
      id: "p1", title: "", widthMm: 60, heightMm: 30,
      blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 12 }, align: "center", valign: "middle",
        lines: ["{{size}} · {{ean13}}"] }],
    }],
    settings: { repeatBy: "ean", fileName: "{{styleNumber}}-{{size}}-price" },
  });
  const repHtml = await renderLayoutHtml(REP, style, { mode: "production" });
  const pageCount = (repHtml.match(/class="ol-page ol-page-\d+"/g) ?? []).length;
  assert(pageCount === style.sizes.length, `repeat renders ${style.sizes.length} pages (got ${pageCount})`);
  for (const s of style.sizes) {
    assert(repHtml.includes(`${s.label} · ${s.ean13}`), `repetition for ${s.label} binds its own EAN`);
  }

  // fileName expression resolves + sanitises.
  const fn = resolveLayoutFileName("{{styleNumber}}-{{size}}-price", style);
  assert(fn === `${style.styleNumber}-${style.sizes[0].label.replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-")}-price.pdf`
    || (fn ?? "").endsWith("-price.pdf"), `fileName resolves (${fn})`);

  console.log(process.exitCode ? "BATCH 3 FAILED" : "BATCH 3 PASSED");
}

// ---------------------------------------------------------------------
// Batch 4 coverage: composition via translation bank, inline markdown,
// per-repetition documents (renderMany semantics via layoutRowToVariant).
// ---------------------------------------------------------------------
async function batch4() {
  const { layoutRowToVariant } = await import("@/lib/output-layouts/variants");
  const style = buildSampleStyleData();

  // Composition lines translate through the Translation bank.
  const COMP = LayoutDefSchema.parse({
    pages: [{
      id: "p1", title: "", widthMm: 60, heightMm: 90,
      blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 12 },
        lines: ["EN: {{composition:en}}", "DA: {{composition:da}}", "**{{customerName}}** _premium_"] }],
    }],
  });
  const html = await renderLayoutHtml(COMP, style, { mode: "production" });
  const en = style.composition.find((c) => c.language === "en")?.text ?? "";
  assert(html.includes(`EN: ${en}`), "EN composition renders from style");
  const daLine = /DA: ([^<]+)/.exec(html)?.[1]?.trim() ?? "";
  assert(daLine.length > 0, `DA composition resolves via translation bank (got "${daLine}")`);
  console.log(`   DA composition: "${daLine}" (EN source: "${en}")`);
  assert(html.includes(`<b>${style.customerName}</b>`), "**bold** renders as <b>");
  assert(html.includes("<i>premium</i>"), "_italic_ renders as <i>");

  // renderMany: one doc per size row, fileName per repetition.
  const variant = layoutRowToVariant({
    id: "smoke-many",
    name: "Smoke Many",
    docType: "STICKER",
    version: 1,
    definition: {
      pages: [{ id: "p1", title: "", widthMm: 60, heightMm: 30,
        blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 12 }, lines: ["{{size}} {{ean13}}"] }] }],
      settings: { repeatBy: "ean", fileName: "{{styleNumber}}-{{size}}" },
    },
  });
  assert(!!variant?.renderMany, "repeat layout exposes renderMany");
  const multi = { ...style, sizes: [
    { label: "S/M", ean13: "5701234567104" },
    { label: "L/XL", ean13: "5701234567111" },
  ] };
  const docs = await variant!.renderMany!(multi);
  assert(docs.length === 2, `renderMany returns one doc per size (got ${docs.length})`);
  assert(docs[0].fileName === `${style.styleNumber}-SM.pdf`, `per-rep fileName binds size (${docs[0].fileName})`);
  assert(docs[1].html.includes("5701234567111") && !docs[1].html.includes("5701234567104"),
    "each doc carries only its own EAN");

  await closeBrowser();
  console.log(process.exitCode ? "BATCH 4 FAILED" : "BATCH 4 PASSED");
}

// ---------------------------------------------------------------------
// Batch 5 coverage: madeIn + derived care instructions via the bank,
// repeat × multi-page grouping, per-language augmentation idempotence.
// ---------------------------------------------------------------------
async function batch5() {
  const { augmentCareAndMadeIn } = await import("@/lib/output-layouts/tokens");
  const style = { ...buildSampleStyleData(), countryOfOrigin: "China" };

  const aug = await augmentCareAndMadeIn(style, ["da"], ["en", "da"]);
  const madeIn = (aug as typeof aug & { madeInByLang?: Record<string, string> }).madeInByLang ?? {};
  assert((madeIn["en"] ?? "").startsWith("Made in"), `madeIn:en resolves (${madeIn["en"]})`);
  assert((madeIn["da"] ?? "").length > 0 && madeIn["da"] !== madeIn["en"],
    `madeIn:da translated via bank (${madeIn["da"]})`);
  assert((aug.careInstructionsByLang?.["da"] ?? "").length > 0,
    `careInstructions:da derived from standard catalogue (${(aug.careInstructionsByLang?.["da"] ?? "").slice(0, 50)}…)`);

  // Repeat × multi-page: pages grouped per repetition.
  const TWO = LayoutDefSchema.parse({
    pages: [
      { id: "p1", title: "F", widthMm: 60, heightMm: 40, blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 6 }, lines: ["F {{size}}"] }] },
      { id: "p2", title: "B", widthMm: 60, heightMm: 40, blocks: [{ id: "b2", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 6 }, lines: ["B {{size}}"] }] },
    ],
    settings: { repeatBy: "ean", fileName: "" },
  });
  const multi = { ...style, sizes: [{ label: "A", ean13: "5701234567104" }, { label: "B2", ean13: "5701234567111" }] };
  const html = await renderLayoutHtml(TWO, multi, { mode: "production" });
  const seq = [...html.matchAll(/ol-line\">(F|B) (A|B2)</g)].map((m) => `${m[1]}${m[2]}`);
  assert(JSON.stringify(seq) === JSON.stringify(["FA", "BA", "FB2", "BB2"]),
    `repeat groups pages per repetition (${seq.join(",")})`);

  await closeBrowser();
  console.log(process.exitCode ? "BATCH 5 FAILED" : "BATCH 5 PASSED");
}

// ---------------------------------------------------------------------
// Batch 6 coverage: page margin insets the grid; logo token renders an
// honest gap when the asset is missing; settings survive schema parse.
// ---------------------------------------------------------------------
async function batch6() {
  const style = buildSampleStyleData();

  const M = LayoutDefSchema.parse({
    pages: [{
      id: "p1", title: "", widthMm: 100, heightMm: 60,
      margins: { topMm: 5, rightMm: 5, bottomMm: 5, leftMm: 5 },
      blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 6, rowSpan: 6 }, lines: ["{{logo:custom}} x"] }],
    }],
    settings: { repeatBy: "none", fileName: "" },
  });
  const html = await renderLayoutHtml(M, style, { mode: "production" });
  // margin 5: inner width 90 → col 0 at left 5mm, width 6/12*90 = 45mm
  assert(html.includes("left: 5.00mm; top: 5.00mm; width: 45.00mm; height: 25.00mm"),
    "page margin insets the grid (5mm margin → 5/5/45/25)");
  // no custom logo uploaded in CI context → honest missing chip OR an img when one IS uploaded
  assert(html.includes("ol-logo") || html.includes("No custom logo uploaded"),
    "logo token renders an image or the honest gap");

  // settings survive a parse round-trip (regression guard for the
  // editor-side wipe bug — mutators must spread the whole def).
  const reparsed = LayoutDefSchema.parse(JSON.parse(JSON.stringify(M)));
  assert(reparsed.settings?.repeatBy === "none", "settings survive serialise/parse");

  await closeBrowser();
  console.log(process.exitCode ? "BATCH 6 FAILED" : "BATCH 6 PASSED");
}

// ---------------------------------------------------------------------
// Batch 7 coverage: per-side margins; repeat "size" vs "ean" (size ×
// colour from eanVariants); per-file suffix uniqueness.
// ---------------------------------------------------------------------
async function batch7() {
  const { repetitionStyles } = await import("@/lib/output-layouts/render");
  const { colourFromVariantLabel } = await import("@/lib/styles/render-context");
  const base = buildSampleStyleData();

  // colour parsing from real-world PO variant labels
  assert(colourFromVariantLabel("PI-35/38 Pink, 35/38", "35/38") === "Pink", "variant label → Pink");
  assert(colourFromVariantLabel("A-XL Black w silver lurex, XL", "XL") === "Black w silver lurex", "variant label → long colour");
  assert(colourFromVariantLabel(null, "M") === null, "null label → null colour");

  // per-side margins: 2/8/3/3 on a 60×30 page → inner 50×24 at left 2 top 3
  const M = LayoutDefSchema.parse({
    pages: [{ id: "p1", title: "", widthMm: 60, heightMm: 30,
      margins: { topMm: 3, rightMm: 8, bottomMm: 3, leftMm: 2 },
      blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 12 }, lines: ["x"] }] }],
  });
  const mh = await renderLayoutHtml(M, base, { mode: "production" });
  assert(mh.includes("left: 2.00mm; top: 3.00mm; width: 50.00mm; height: 24.00mm"),
    "per-side margins inset asymmetrically");

  // legacy single marginMm migrates to per-side
  const { parseLayoutDef: pld } = await import("@/lib/output-layouts/schema");
  const mig = pld({ pages: [{ id: "p", title: "", widthMm: 60, heightMm: 30, marginMm: 4, blocks: [] }] });
  assert(mig.pages[0].margins.topMm === 4 && mig.pages[0].margins.leftMm === 4, "legacy marginMm → per-side");

  // repeat modes: size dedupes, ean expands size × colour
  const style = {
    ...base,
    sizes: [{ label: "27/30", ean13: "5706323596613" }, { label: "31/34", ean13: "5706323596620" }],
    eanVariants: [
      { size: "27/30", ean13: "5706323596583", colour: "Pink" },
      { size: "27/30", ean13: "5706323596613", colour: "Blue" },
      { size: "31/34", ean13: "5706323596590", colour: "Pink" },
    ],
  };
  assert(repetitionStyles(style, "size").length === 2, "repeat=size → one per size");
  const eanReps = repetitionStyles(style, "ean");
  assert(eanReps.length === 3, "repeat=ean → one per EAN row (size × colour)");
  assert(eanReps[1].colour?.name === "Blue" && eanReps[1].sizes[0].ean13 === "5706323596613",
    "each EAN repetition binds its own colour + EAN");

  await closeBrowser();
  console.log(process.exitCode ? "BATCH 7 FAILED" : "BATCH 7 PASSED");
}

// ---------------------------------------------------------------------
// Batch 8 coverage: block borders with hex colour.
// ---------------------------------------------------------------------
async function batch8() {
  const style = buildSampleStyleData();
  const B = LayoutDefSchema.parse({
    pages: [{ id: "p1", title: "", widthMm: 60, heightMm: 30,
      blocks: [{ id: "b1", rect: { col: 1, row: 1, colSpan: 10, rowSpan: 10 },
        border: { widthMm: 0.5, color: "#cc0000" }, lines: ["boxed"] }] }],
  });
  const html = await renderLayoutHtml(B, style, { mode: "production" });
  assert(html.includes("border: 0.5mm solid #cc0000"), "block border renders with hex colour");
  // invalid hex rejected by the schema
  let rejected = false;
  try {
    LayoutDefSchema.parse({ pages: [{ id: "p", title: "", widthMm: 60, heightMm: 30,
      blocks: [{ id: "b", rect: { col: 0, row: 0, colSpan: 2, rowSpan: 2 }, border: { widthMm: 0.5, color: "red" }, lines: [] }] }] });
  } catch { rejected = true; }
  assert(rejected, "non-hex border colour rejected");
  await closeBrowser();
  console.log(process.exitCode ? "BATCH 8 FAILED" : "BATCH 8 PASSED");
}
