import { marked } from "marked";

// =====================================================
// Bundle framing pages — the two A4 documents the runner prepends to
// every generated bundle:
//
//   • Cover page — "what's in this package and at what dimensions".
//     Built from the job's FINAL generated-document list (post skip-
//     filtering), so a skipped output never appears on it. Each output
//     is listed once — title + W×H mm — even when a multi-document
//     variant emitted several files (the Files column carries the count).
//
//   • General information page — ProdSpec.generalInfoMd (GitHub-
//     flavoured markdown, tables included) rendered to A4. Written once
//     per ProdSpec, shipped with every bundle under it. Long content
//     flows onto further A4 pages naturally.
//
// Both render through the existing Puppeteer pipeline (renderPdf — A4,
// zero margins, preferCSSPageSize). The markdown is admin-authored only
// (same trust boundary as ProdSpec.logoSvg, which is already injected
// into label HTML verbatim), so no sanitiser pass here.
// =====================================================

// Reserved synthetic variantKeys for the bundle pages' JobAsset rows.
// Double-underscore framing keeps them impossible to collide with
// catalogue keys (kebab-case) or Output Builder keys ("layout:<id>"),
// and `@@unique([jobId, variantKey])` holds since each appears once.
export const COVER_VARIANT_KEY = "__cover__";
export const GENERAL_INFO_VARIANT_KEY = "__general_info__";

export type BundleDocSummary = {
  // Variant display name, listed once per output ("Care Label 02 · Long
  // folded label (4 sheets)" → we print the variant `name` as-is).
  displayName: string;
  widthMm: number;
  heightMm: number;
  // PDFs this output produced (renderMany variants emit one per size/EAN).
  // null ⇒ unknown at render time (editor preview) — shown as "—".
  fileCount: number | null;
};

export type CoverPageInput = {
  customerName: string;
  businessArea: string | null;
  styleName: string;
  styleNumber: string;
  poNumber: string | null;
  supplierName: string | null;
  generatedAt: Date;
  docs: BundleDocSummary[];
};

export type GeneralInfoInput = {
  markdown: string;
  customerName: string;
  businessArea: string | null;
};

export function renderCoverPageHtml(input: CoverPageInput): string {
  const meta: Array<[string, string]> = [
    ["Style", `${input.styleName} · ${input.styleNumber}`],
    ...(input.poNumber ? ([["PO number", input.poNumber]] as Array<[string, string]>) : []),
    ...(input.supplierName ? ([["Supplier", input.supplierName]] as Array<[string, string]>) : []),
  ];

  const rows = input.docs
    .map(
      (d, i) => `
        <tr>
          <td class="num">${i + 1}</td>
          <td class="doc">${esc(d.displayName)}</td>
          <td class="size">${fmtMm(d.widthMm)} × ${fmtMm(d.heightMm)} mm</td>
          <td class="files">${d.fileCount === null ? "—" : d.fileCount}</td>
        </tr>`,
    )
    .join("");

  const body = `
    <h1>Production specification</h1>
    <p class="subtitle">${esc(input.customerName)}${
      input.businessArea ? ` · ${esc(input.businessArea)}` : ""
    } · generated ${esc(fmtDate(input.generatedAt))}</p>
    <div class="rule"></div>
    <table class="meta">
      ${meta
        .map(
          ([k, v]) => `
        <tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`,
        )
        .join("")}
    </table>
    <div class="caption">Documents in this bundle</div>
    <table class="docs">
      <thead>
        <tr><th>#</th><th>Document</th><th>Size (W × H)</th><th>Files</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">
      All dimensions are finished print sizes. Artwork files are supplied at 1:1 scale with
      no bleed unless stated on the document itself.
    </p>`;

  return a4Document({
    title: "Cover page",
    body,
    extraCss: COVER_CSS,
    footerLeft: `Prod Spec · ${esc(input.customerName)}${
      input.businessArea ? ` · ${esc(input.businessArea)}` : ""
    }`,
    footerRight: `Generated ${esc(fmtDate(input.generatedAt))}`,
  });
}

export function renderGeneralInfoHtml(input: GeneralInfoInput): string {
  // gfm (tables, strikethrough, autolinks) is marked's default profile;
  // async:false guarantees a string return and would throw loudly if an
  // async extension ever sneaks into the marked config.
  const rendered = marked.parse(input.markdown, { async: false });

  return a4Document({
    title: "General information",
    body: `<div class="md">${rendered}</div>`,
    extraCss: MARKDOWN_CSS,
    footerLeft: "General information · applies to all styles under this prod spec",
    footerRight: `${esc(input.customerName)}${
      input.businessArea ? ` · ${esc(input.businessArea)}` : ""
    }`,
  });
}

// ---------------------------------------------------------------------
// Shared A4 shell. The fixed footer repeats on every printed page (Chrome
// repeats position:fixed elements per page) — no @page margin boxes, which
// Chromium doesn't support. Body bottom padding keeps content clear of it.
// ---------------------------------------------------------------------

function a4Document(opts: {
  title: string;
  body: string;
  extraCss: string;
  footerLeft: string;
  footerRight: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)}</title>
<style>
  @page { size: 210mm 297mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: 210mm;
    padding: 18mm 18mm 26mm;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10pt;
    line-height: 1.55;
    color: #1c1c1e;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .a4-footer {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    padding: 3mm 18mm 8mm;
    border-top: 0.3mm solid #d4d4d8;
    display: flex;
    justify-content: space-between;
    gap: 6mm;
    font-size: 7pt;
    color: #a1a1aa;
    background: #fff;
  }
${opts.extraCss}
</style>
</head>
<body>
${opts.body}
<div class="a4-footer"><span>${opts.footerLeft}</span><span>${opts.footerRight}</span></div>
</body>
</html>`;
}

const COVER_CSS = `
  h1 {
    margin: 0;
    font-size: 17pt;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .subtitle { margin: 1mm 0 0; font-size: 9pt; color: #71717a; }
  .rule { border-top: 0.6mm solid #1c1c1e; margin: 6mm 0 5mm; }
  table { width: 100%; border-collapse: collapse; }
  table.meta td { padding: 1.2mm 0; font-size: 10pt; vertical-align: top; }
  table.meta td.k { width: 38mm; color: #71717a; }
  .caption {
    margin: 9mm 0 0;
    font-size: 8pt;
    font-weight: bold;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #71717a;
  }
  table.docs { margin-top: 2mm; }
  table.docs th {
    text-align: left;
    font-size: 7.5pt;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #71717a;
    border-bottom: 0.3mm solid #d4d4d8;
    padding: 1.6mm 2mm;
  }
  table.docs td {
    padding: 2mm;
    border-bottom: 0.2mm solid #ececee;
    font-size: 9.5pt;
    vertical-align: top;
  }
  table.docs td.num { width: 8mm; color: #a1a1aa; }
  table.docs td.doc { font-weight: bold; }
  table.docs td.size { width: 38mm; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.docs td.files { width: 16mm; text-align: right; font-variant-numeric: tabular-nums; }
  .note { margin-top: 5mm; font-size: 8pt; color: #71717a; }
`;

const MARKDOWN_CSS = `
  .md h1 { font-size: 15pt; margin: 0 0 3mm; }
  .md h2 {
    font-size: 12pt;
    margin: 7mm 0 2mm;
    padding-bottom: 1mm;
    border-bottom: 0.2mm solid #e4e4e7;
    break-after: avoid;
  }
  .md h3 { font-size: 10.5pt; margin: 5mm 0 1.5mm; break-after: avoid; }
  .md p { margin: 0 0 2.5mm; }
  .md ul, .md ol { margin: 0 0 2.5mm; padding-left: 6mm; }
  .md li { margin: 0 0 1mm; }
  .md table { width: 100%; border-collapse: collapse; margin: 2mm 0 4mm; }
  .md th {
    text-align: left;
    font-size: 8pt;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #52525b;
    background: #f4f4f5;
    border: 0.2mm solid #d4d4d8;
    padding: 1.8mm 2.2mm;
  }
  .md td { border: 0.2mm solid #d4d4d8; padding: 1.8mm 2.2mm; font-size: 9.5pt; vertical-align: top; }
  .md tr { break-inside: avoid; }
  .md code {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 8.5pt;
    background: #f4f4f5;
    border: 0.2mm solid #ececee;
    border-radius: 1mm;
    padding: 0 1mm;
  }
  .md pre {
    background: #f4f4f5;
    border: 0.2mm solid #e4e4e7;
    border-radius: 1.5mm;
    padding: 3mm;
    overflow: hidden;
    break-inside: avoid;
  }
  .md pre code { background: none; border: none; padding: 0; }
  .md blockquote {
    margin: 0 0 2.5mm;
    padding: 1mm 0 1mm 4mm;
    border-left: 1mm solid #d4d4d8;
    color: #52525b;
  }
  .md hr { border: none; border-top: 0.2mm solid #e4e4e7; margin: 5mm 0; }
  .md img { max-width: 100%; }
`;

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// "35" / "35.5" — mm values without trailing zero noise.
function fmtMm(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
