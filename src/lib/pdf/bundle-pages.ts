import { marked } from "marked";
import { DEFAULT_PAGE_SETTINGS, type PageSettings } from "@/lib/prod-spec/config";

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
// Layout model (probed in Chromium — see PR notes):
//   • Margins are REAL `@page` margins from PageSettings, so every sheet
//     of a multi-page document gets them (body-padding only margins the
//     first/last page).
//   • On screen `@page` is ignored, so the same margins repeat as
//     padding on the `.a4-shell` wrapper under `@media screen` — that is
//     what the editor preview iframes show. (The preview normalizer
//     zeroes BODY padding, which is why margins used to look squashed.)
//   • Footers: fixed-position footers don't paint on page 1 when pushed
//     into the @page margin, so the cover (single page by design) pins
//     its footer absolutely inside the page box, and the general info
//     document signs off once at the end of the flow.
//   • Type scales from PageSettings.baseFontPt — all sizes are em.
//
// The markdown is admin-authored only (same trust boundary as
// ProdSpec.logoSvg, which is already injected into label HTML verbatim),
// so no sanitiser pass here.
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
  settings?: PageSettings;
};

export type GeneralInfoInput = {
  markdown: string;
  customerName: string;
  businessArea: string | null;
  settings?: PageSettings;
};

export function renderCoverPageHtml(input: CoverPageInput): string {
  const settings = input.settings ?? DEFAULT_PAGE_SETTINGS;
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
    mode: "page",
    body,
    extraCss: COVER_CSS,
    settings,
    footerLeft: `Prod Spec · ${esc(input.customerName)}${
      input.businessArea ? ` · ${esc(input.businessArea)}` : ""
    }`,
    footerRight: `Generated ${esc(fmtDate(input.generatedAt))}`,
  });
}

export function renderGeneralInfoHtml(input: GeneralInfoInput): string {
  const settings = input.settings ?? DEFAULT_PAGE_SETTINGS;
  // gfm (tables, strikethrough, autolinks) is marked's default profile;
  // async:false guarantees a string return and would throw loudly if an
  // async extension ever sneaks into the marked config.
  const rendered = marked.parse(input.markdown, { async: false });

  return a4Document({
    title: "General information",
    mode: "flow",
    body: `<div class="md">${rendered}</div>`,
    extraCss: MARKDOWN_CSS,
    settings,
    footerLeft: "General information · applies to all styles under this prod spec",
    footerRight: `${esc(input.customerName)}${
      input.businessArea ? ` · ${esc(input.businessArea)}` : ""
    }`,
  });
}

// ---------------------------------------------------------------------
// Shared A4 shell.
//   mode "page" — single-page document (cover): footer pinned to the
//   bottom of the page box via absolute positioning.
//   mode "flow" — multi-page document (general info): footer once at the
//   end of the content flow.
// ---------------------------------------------------------------------

function a4Document(opts: {
  title: string;
  mode: "page" | "flow";
  body: string;
  extraCss: string;
  settings: PageSettings;
  footerLeft: string;
  footerRight: string;
}): string {
  const s = opts.settings;
  const margins = `${mm(s.marginTopMm)} ${mm(s.marginRightMm)} ${mm(s.marginBottomMm)} ${mm(s.marginLeftMm)}`;
  // Content-area height of one A4 page — the cover pins its footer to it.
  const pageInnerMm = Math.max(60, 297 - s.marginTopMm - s.marginBottomMm);

  const footer = s.showFooter
    ? `<div class="a4-footer"><span>${opts.footerLeft}</span><span>${opts.footerRight}</span></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)}</title>
<style>
  /* Real per-page margins — applied to every sheet when printing. */
  @page { size: 210mm 297mm; margin: ${margins}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: ${s.baseFontPt}pt;
    line-height: ${s.lineHeight};
    color: #1c1c1e;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .a4-page { position: relative; min-height: ${mm(pageInnerMm)}; }
  .a4-page .a4-footer { position: absolute; left: 0; right: 0; bottom: 0; }
  .a4-flow .a4-footer { margin-top: 8mm; }
  .a4-footer {
    display: flex;
    justify-content: space-between;
    gap: 6mm;
    padding-top: 1.5mm;
    border-top: 0.3mm solid #d4d4d8;
    font-size: 0.7em;
    color: #a1a1aa;
    background: #fff;
  }
  /* On screen @page is ignored — the editor preview shows the same
     margins as shell padding instead. (Print keeps the shell at 0 so
     @page margins are the single source of truth on paper.) */
  @media screen {
    body { width: 210mm; background: #fff; }
    .a4-shell { padding: ${margins}; }
  }
${opts.extraCss}
</style>
</head>
<body>
<div class="a4-shell"><div class="${opts.mode === "page" ? "a4-page" : "a4-flow"}">
${opts.body}
${footer}
</div></div>
</body>
</html>`;
}

// Type scales from the base font: everything in em so PageSettings.
// baseFontPt resizes the whole document coherently.
const COVER_CSS = `
  h1 {
    margin: 0;
    font-size: 1.7em;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .subtitle { margin: 1mm 0 0; font-size: 0.9em; color: #71717a; }
  .rule { border-top: 0.6mm solid #1c1c1e; margin: 6mm 0 5mm; }
  table { width: 100%; border-collapse: collapse; }
  table.meta td { padding: 1.2mm 0; vertical-align: top; }
  table.meta td.k { width: 38mm; color: #71717a; }
  .caption {
    margin: 9mm 0 0;
    font-size: 0.8em;
    font-weight: bold;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #71717a;
  }
  table.docs { margin-top: 2mm; }
  table.docs th {
    text-align: left;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #71717a;
    border-bottom: 0.3mm solid #d4d4d8;
    padding: 1.6mm 2mm;
  }
  table.docs td {
    padding: 2mm;
    border-bottom: 0.2mm solid #ececee;
    font-size: 0.95em;
    vertical-align: top;
  }
  table.docs td.num { width: 8mm; color: #a1a1aa; }
  table.docs td.doc { font-weight: bold; }
  table.docs td.size { width: 38mm; white-space: nowrap; font-variant-numeric: tabular-nums; }
  table.docs td.files { width: 16mm; text-align: right; font-variant-numeric: tabular-nums; }
  .note { margin-top: 5mm; font-size: 0.8em; color: #71717a; }
`;

const MARKDOWN_CSS = `
  .md h1 { font-size: 1.5em; margin: 0 0 3mm; }
  .md h2 {
    font-size: 1.2em;
    margin: 7mm 0 2mm;
    padding-bottom: 1mm;
    border-bottom: 0.2mm solid #e4e4e7;
    break-after: avoid;
  }
  .md h3 { font-size: 1.05em; margin: 5mm 0 1.5mm; break-after: avoid; }
  .md p { margin: 0 0 2.5mm; }
  .md ul, .md ol { margin: 0 0 2.5mm; padding-left: 6mm; }
  .md li { margin: 0 0 1mm; }
  .md table { width: 100%; border-collapse: collapse; margin: 2mm 0 4mm; }
  .md th {
    text-align: left;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #52525b;
    background: #f4f4f5;
    border: 0.2mm solid #d4d4d8;
    padding: 1.8mm 2.2mm;
  }
  .md td { border: 0.2mm solid #d4d4d8; padding: 1.8mm 2.2mm; font-size: 0.95em; vertical-align: top; }
  .md tr { break-inside: avoid; }
  .md code {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 0.85em;
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

function mm(n: number): string {
  return `${fmtMm(n)}mm`;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
