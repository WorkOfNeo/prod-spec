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
//     When the prod spec has general info, those pages are ALSO appended
//     into this document (own @page margins via named pages), so the
//     requirements can't be missed by someone who only opens the cover.
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

// Reserved synthetic variantKeys for the bundle pages' JobAsset rows live in
// bundle-page-keys.ts (no render-pipeline imports) and are re-exported here so
// existing callers keep importing them from this module.
export { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "./bundle-page-keys";

// The manifest row type now lives in the import-free leaf alongside the
// variant keys, because the pure trims assembler and the settings screens need
// it without the render pipeline. Re-exported so existing importers are
// unaffected.
import type { BundleDocSummary } from "./bundle-page-keys";
export type { BundleDocSummary } from "./bundle-page-keys";

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
  // When set (non-empty markdown), the general-information pages are
  // appended INTO the cover document after the cover sheet — named @page
  // rules keep each section's own margins and type scale. The standalone
  // 01 document still ships alongside; the cover carries the requirements
  // so they can't be missed by someone who only opens/prints the cover.
  generalInfo?: { markdown: string; settings?: PageSettings } | null;
  // GLOBAL cover content block (AppSetting "coverPageInfoMd") — admin-authored
  // markdown printed on the cover SHEET itself (page 1), below the required-
  // packaging manifest. Same trust boundary as generalInfo (admin-only), so no
  // sanitiser pass. Empty/absent ⇒ nothing rendered. Its images are inlined by
  // renderStyleCoverPdf before the PDF pass.
  coverInfo?: { markdown: string } | null;
};

export type GeneralInfoInput = {
  markdown: string;
  customerName: string;
  businessArea: string | null;
  settings?: PageSettings;
};

// Does this manifest have ≥1 not-yet-approved row?
//
// Two things key off this and they MUST agree:
//   • the cover render — a pending row switches the Status column on, so the
//     supplier reads the manifest as "what's still to come". When every row is
//     approved (or approval isn't tracked, e.g. the editor preview) the sizes
//     are all confirmed and the column would just be a wall of "Approved".
//   • the "Regenerate cover pages" sweep — an all-approved cover prints no
//     status wording at all, so re-rendering it changes nothing visible while
//     still overwriting the supplier's file for a finished order. The sweep
//     skips those (see refreshStyleCoverAsset's onlyWhenPending).
//
// Shared rather than duplicated: if these two ever disagreed, the sweep would
// either skip covers that DO show pending wording or churn ones that don't.
export function hasPendingRows(docs: ReadonlyArray<{ approved?: boolean }>): boolean {
  return docs.some((d) => d.approved === false);
}

export function renderCoverPageHtml(input: CoverPageInput): string {
  const settings = input.settings ?? DEFAULT_PAGE_SETTINGS;
  const meta: Array<[string, string]> = [
    ["Style", `${input.styleName} · ${input.styleNumber}`],
    ...(input.poNumber ? ([["PO number", input.poNumber]] as Array<[string, string]>) : []),
    ...(input.supplierName ? ([["Supplier", input.supplierName]] as Array<[string, string]>) : []),
  ];

  const hasPending = hasPendingRows(input.docs);
  // Drives the second half of the note below: without a packing-instruction row
  // on the page, explaining that marking would describe something the supplier
  // cannot find — the same trap the pending wording has.
  const hasInfoRows = input.docs.some((d) => d.kind === "info");
  // A packing instruction (hanger, polybag, carton) has no delivery state and
  // never will — parking it at "Waiting for Customer Information" alongside the
  // artwork rows would bury the rows that genuinely are waiting. It says what it
  // is instead, and points at the instructions already printed below.
  const statusCell = (d: BundleDocSummary): string => {
    if (d.kind === "info") return `<span class="note-cell">See packing instructions</span>`;
    if (d.approved === true) return `<span class="ok">Approved</span>`;
    if (d.approved === false) return `<span class="await">Waiting for Customer Information</span>`;
    return "—";
  };
  const rows = input.docs
    .map((d, i) => {
      // Only an app-generated row has one document (and therefore one finished
      // size) behind it. A manually supplied item, a packing instruction, or a
      // Monday entry answered by several documents prints no size rather than a
      // misleading one.
      const size =
        d.widthMm !== null && d.heightMm !== null
          ? `${fmtMm(d.widthMm)} × ${fmtMm(d.heightMm)} mm`
          : "—";
      // Monday's wording is the row's identity so the supplier can tick the
      // cover off against the order; the document name goes underneath, because
      // "Wash Care Label with Oeko-tex Logo" and the file called
      // "…Care Label.pdf" are otherwise impossible to connect.
      const suppliedAs = d.suppliedAs?.length
        ? `<div class="via">Supplied as ${esc(d.suppliedAs.join(" + "))}</div>`
        : "";
      return `
        <tr class="${d.approved === false ? "pending" : ""}">
          <td class="num">${i + 1}</td>
          <td class="doc">${esc(d.displayName)}${suppliedAs}</td>
          <td class="size">${size}</td>
          ${hasPending ? `<td class="status">${statusCell(d)}</td>` : ""}
        </tr>`;
    })
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
    <div class="caption">Required packaging for this order</div>
    <table class="docs">
      <thead>
        <tr><th>#</th><th>Packaging</th><th>Size (W × H)</th>${
          hasPending ? "<th>Status</th>" : ""
        }</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="note">
      All required packaging for this order is listed above. All dimensions are finished print
      sizes; artwork files are supplied at 1:1 scale with no bleed unless stated on the document
      itself.${
        hasInfoRows
          ? ` Items marked <strong>See packing instructions</strong> are packaging materials rather than
      artwork — no file is supplied for them; follow the packing requirements in this document.`
          : ""
      }${
        hasPending
          ? ` Items marked <strong>Waiting for Customer Information</strong> are still under review — their
      artwork will follow once approved, so please expect them.`
          : ""
      }
    </p>`;

  // Global cover content block — admin-authored boilerplate printed on the cover
  // sheet, below the manifest. gfm profile, async:false (a string return is
  // guaranteed; an async extension would throw loudly). Images are already
  // inlined to data URLs by the time this renders (renderStyleCoverPdf).
  const coverInfoMd = input.coverInfo?.markdown.trim();
  const coverInfoBlock = coverInfoMd
    ? `<div class="cover-info md">${marked.parse(coverInfoMd, { async: false })}</div>`
    : "";

  const sections: A4Section[] = [
    {
      pageName: null, // default @page — the cover's own margins
      mode: "page",
      body: `<div class="cov">${body}${coverInfoBlock}</div>`,
      // The cover sheet can now carry markdown (the global block), so the
      // markdown type styles ride along with the cover styles on this section.
      extraCss: `${COVER_CSS}\n${MARKDOWN_CSS}`,
      settings,
      footerLeft: `Prod Spec · ${esc(input.customerName)}${
        input.businessArea ? ` · ${esc(input.businessArea)}` : ""
      }`,
      footerRight: `Generated ${esc(fmtDate(input.generatedAt))}`,
    },
  ];

  // Requirements ride along in the cover document itself, on their own
  // sheets with the general-info section's margins and type scale.
  const giMd = input.generalInfo?.markdown.trim();
  if (giMd) {
    sections.push(
      generalInfoSection(giMd, input.generalInfo?.settings ?? DEFAULT_PAGE_SETTINGS, {
        customerName: input.customerName,
        businessArea: input.businessArea,
      }),
    );
  }

  return a4Document({ title: "Cover page", sections });
}

export function renderGeneralInfoHtml(input: GeneralInfoInput): string {
  const settings = input.settings ?? DEFAULT_PAGE_SETTINGS;
  return a4Document({
    title: "General information",
    sections: [
      generalInfoSection(input.markdown, settings, {
        customerName: input.customerName,
        businessArea: input.businessArea,
      }),
    ],
  });
}

// The general-info content as a section — identical whether it ships as
// the standalone 01 document or appended inside the cover document.
function generalInfoSection(
  markdown: string,
  settings: PageSettings,
  ctx: { customerName: string; businessArea: string | null },
): A4Section {
  // gfm (tables, strikethrough, autolinks) is marked's default profile;
  // async:false guarantees a string return and would throw loudly if an
  // async extension ever sneaks into the marked config.
  const rendered = marked.parse(markdown, { async: false });
  return {
    pageName: "gi",
    mode: "flow",
    body: `<div class="md">${rendered}</div>`,
    extraCss: MARKDOWN_CSS,
    settings,
    footerLeft: "General information · applies to all styles under this prod spec",
    footerRight: `${esc(ctx.customerName)}${
      ctx.businessArea ? ` · ${esc(ctx.businessArea)}` : ""
    }`,
  };
}

// ---------------------------------------------------------------------
// Shared A4 shell — one document, one or more SECTIONS.
//
// Each section owns its margins + type scale. Sections after the first
// start on a fresh sheet, and a NAMED `@page` rule (CSS `page:` property,
// same pattern as the Output Builder's `@page olp<i>` rules) carries that
// section's margins onto every sheet it flows across.
//
//   mode "page" — single-sheet section (cover): footer pinned to the
//   bottom of the page box via absolute positioning.
//   mode "flow" — multi-sheet section (general info): footer once at the
//   end of the content flow.
// ---------------------------------------------------------------------

type A4Section = {
  // null → styled via the default (unnamed) @page rule. Named sections
  // get `page: <name>` so their margins apply on every sheet they span.
  pageName: string | null;
  mode: "page" | "flow";
  body: string;
  extraCss: string;
  settings: PageSettings;
  footerLeft: string;
  footerRight: string;
};

function a4Document(opts: { title: string; sections: A4Section[] }): string {
  const pageRules = opts.sections
    .map(
      (s) =>
        `@page ${s.pageName ?? ""} { size: 210mm 297mm; margin: ${marginsCss(s.settings)}; }`,
    )
    .join("\n  ");

  const sectionCss = opts.sections
    .map((s, i) => {
      // Content-area height of one A4 sheet — "page" sections pin their
      // footer to it.
      const pageInnerMm = Math.max(60, 297 - s.settings.marginTopMm - s.settings.marginBottomMm);
      return `
  .sec${i} {
    ${s.pageName ? `page: ${s.pageName};` : ""}
    ${i > 0 ? "break-before: page;" : ""}
    font-size: ${s.settings.baseFontPt}pt;
    line-height: ${s.settings.lineHeight};
  }
  .sec${i} .a4-page { min-height: ${mm(pageInnerMm)}; }
  /* On screen @page is ignored — the editor preview shows the same
     margins as section padding instead. (Print keeps padding at 0 so
     @page margins are the single source of truth on paper.) */
  @media screen {
    .sec${i} { padding: ${marginsCss(s.settings)}; }
    ${i > 0 ? `.sec${i} { border-top: 1px dashed #d4d4d8; }` : ""}
  }`;
    })
    .join("\n");

  const bodies = opts.sections
    .map((s, i) => {
      const footer = s.settings.showFooter
        ? `<div class="a4-footer"><span>${s.footerLeft}</span><span>${s.footerRight}</span></div>`
        : "";
      return `<div class="sec${i}"><div class="${s.mode === "page" ? "a4-page" : "a4-flow"}">
${s.body}
${footer}
</div></div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)}</title>
<style>
  /* Real per-page margins — applied to every sheet when printing. */
  ${pageRules}
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    color: #1c1c1e;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .a4-page { position: relative; }
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
  @media screen {
    body { width: 210mm; background: #fff; }
  }
${sectionCss}
${opts.sections.map((s) => s.extraCss).join("\n")}
</style>
</head>
<body>
${bodies}
</body>
</html>`;
}

// Type scales from the base font: everything in em so PageSettings.
// baseFontPt resizes the whole document coherently. Scoped under .cov —
// the cover can share a document with the markdown section, and an
// unscoped h1/table rule would leak into it.
const COVER_CSS = `
  .cov h1 {
    margin: 0;
    font-size: 1.7em;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .cov .subtitle { margin: 1mm 0 0; font-size: 0.9em; color: #71717a; }
  .cov .rule { border-top: 0.6mm solid #1c1c1e; margin: 6mm 0 5mm; }
  .cov table { width: 100%; border-collapse: collapse; }
  .cov table.meta td { padding: 1.2mm 0; vertical-align: top; }
  .cov table.meta td.k { width: 38mm; color: #71717a; }
  .cov .caption {
    margin: 9mm 0 0;
    font-size: 0.8em;
    font-weight: bold;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #71717a;
  }
  .cov table.docs { margin-top: 2mm; }
  .cov table.docs th {
    text-align: left;
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #71717a;
    border-bottom: 0.3mm solid #d4d4d8;
    padding: 1.6mm 2mm;
  }
  .cov table.docs td {
    padding: 2mm;
    border-bottom: 0.2mm solid #ececee;
    font-size: 0.95em;
    vertical-align: top;
  }
  .cov table.docs td.num { width: 8mm; color: #a1a1aa; }
  .cov table.docs td.doc { font-weight: bold; }
  /* The document a Monday entry is actually delivered as — secondary to the
     entry itself, which is what the supplier reads against their order. */
  .cov table.docs td.doc .via {
    margin-top: 0.6mm;
    font-weight: normal;
    font-size: 0.82em;
    color: #71717a;
  }
  .cov table.docs .note-cell { color: #71717a; font-size: 0.85em; }
  .cov table.docs td.size { width: 38mm; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .cov table.docs td.status { width: 52mm; }
  /* Pending rows: the size is the PLANNED dimension, not yet confirmed by
     Contrast — mute it so it reads as provisional next to the amber flag. */
  .cov table.docs tr.pending td.size { color: #a1a1aa; }
  .cov table.docs .ok {
    color: #15803d;
    font-weight: bold;
    font-size: 0.9em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .cov table.docs .await {
    display: inline-block;
    color: #b45309;
    background: #fef3c7;
    border: 0.2mm solid #fcd34d;
    border-radius: 1mm;
    padding: 0.3mm 1.6mm;
    font-size: 0.82em;
    font-weight: bold;
  }
  .cov .note { margin-top: 5mm; font-size: 0.8em; color: #71717a; }
  /* Global cover content block — sits on the cover sheet under the manifest,
     set off by a hairline rule. Its inner markdown inherits the .md type
     styles; keep the first element flush to the rule. */
  .cov .cover-info {
    margin-top: 7mm;
    padding-top: 5mm;
    border-top: 0.3mm solid #d4d4d8;
    font-size: 0.9em;
  }
  .cov .cover-info > :first-child { margin-top: 0; }
  .cov .cover-info img { max-width: 100%; }
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

// "12mm 10mm 14mm 10mm" — TRBL margin shorthand from PageSettings.
function marginsCss(s: PageSettings): string {
  return `${mm(s.marginTopMm)} ${mm(s.marginRightMm)} ${mm(s.marginBottomMm)} ${mm(s.marginLeftMm)}`;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
