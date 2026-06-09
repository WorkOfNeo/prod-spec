import type { StyleData } from "../types";
import type { OutputDims } from "../template-registry";
import { escapeHtml, htmlDocument } from "./base";
import { renderBarcodeDataUrl } from "../barcode";

// care-label-01 — 35×40 mm white satin care label.
// Layout, top to bottom (centred):
//   • ProdSpec logo (SVG) — omitted entirely when not set
//   • "Size / Stl / Str" heading
//   • Size label (same point size as heading by request)
//   • EAN-13 barcode, full-width, anchored to the bottom
// One page per size variant; the runner produces one PDF per output, the
// PDF contains as many pages as there are sizes on the Style.
//
// Barcode is rendered via bwip-js PNG (vs the earlier Libre Barcode font
// path) so it can scale to 100% width of the label without depending on
// font metrics, and so the digits don't leak the EAN-13 guard glyphs
// (">", "<") when the data is the placeholder "0000000000000".
export async function renderCareLabel01Html(style: StyleData, dims: OutputDims): Promise<string> {
  const pageSize = { kind: "mm" as const, widthMm: dims.widthMm, heightMm: dims.heightMm };

  const logoBlock = renderLogoBlock(style.prodSpecLogoSvg);

  // When the Style has no sizes configured (sizes / EAN columns empty
  // or enrichment hasn't landed), still emit one fallback page so the
  // operator sees the label LAYOUT and a clear "missing data" signal
  // rather than a blank PDF.
  const sizesToRender = style.sizes.length > 0
    ? style.sizes
    : [{ label: "—", ean13: "0000000000000" } as const];

  // Render every size's barcode in parallel. bwip-js rejects EAN-13
  // strings with a bad check digit (which can happen when upstream
  // mapping is half-configured); we fall back to a plain-text "no
  // barcode" placeholder so the rest of the label still prints. Valid
  // placeholder "0000000000000" works fine — its check digit IS 0.
  const sizeBlocks = await Promise.all(
    sizesToRender.map(async (size) => {
      let barcodeHtml: string;
      if (size.ean13 === "0000000000000") {
        // No usable EAN: either the column was empty or the entered
        // value failed EAN-13 check-digit validation in the mapper.
        // Show an explicit notice rather than a zeros barcode, which
        // reads as a real (but wrong) code on the printed label.
        barcodeHtml = `<div class="barcode-missing">No valid EAN for ${escapeHtml(size.label)}</div>`;
      } else {
        try {
          const barcodeDataUrl = await renderBarcodeDataUrl(size.ean13, {
            scale: 3,
            height: 10,
            includetext: true,
            textxalign: "center",
          });
          barcodeHtml = `<img src="${barcodeDataUrl}" alt="${escapeHtml(size.ean13)}" />`;
        } catch {
          barcodeHtml = `<div class="barcode-missing">EAN ${escapeHtml(size.ean13)} — invalid</div>`;
        }
      }
      return `
      <div class="page">
        ${logoBlock}
        <div class="size-heading">Size / Stl / Str</div>
        <div class="size-label">${escapeHtml(size.label)}</div>
        <div class="barcode">${barcodeHtml}</div>
      </div>`;
    }),
  );

  return htmlDocument({
    title: `Care Label 01 — ${style.styleName}`,
    pageSize,
    body: sizeBlocks.join("\n"),
    barcodeFont: style.barcodeFont,
    extraCss: `
      /* Explicit page height (not height:100%) so the flex column fills
         the physical page — a percentage height resolves against body,
         which has no height set, and collapses to content height,
         defeating the margin-top:auto bottom anchor below. */
      .page {
        padding: 2mm 2.5mm 3mm;
        display: flex;
        flex-direction: column;
        align-items: center;
        height: ${dims.heightMm}mm;
      }
      .logo {
        width: 16mm;
        height: 7mm;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-top: 1mm;
      }
      .logo svg { width: 100%; height: 100%; }
      .logo img { width: 100%; height: 100%; object-fit: contain; }
      .size-heading {
        margin-top: 1.5mm;
        font-size: 6pt;
        letter-spacing: 0.04em;
      }
      .size-label {
        margin-top: 1mm;
        /* Same point size as the heading per spec — the bold variant
           keeps it visually distinct without scaling. */
        font-size: 6pt;
        font-weight: 700;
        line-height: 1;
      }
      /* Barcode block: anchored to the bottom of the label, fills the
         entire usable width. PNG keeps its aspect ratio via height:auto
         so the bars stay sharp; vertical height is bounded by the
         remaining space (~ 14 mm after logo + size text + padding). */
      .barcode {
        margin-top: auto;
        width: 100%;
      }
      .barcode img {
        display: block;
        width: 100%;
        height: auto;
        max-height: 14mm;
      }
      .barcode-missing {
        font-size: 5pt;
        color: #a00;
        text-align: center;
        padding: 1mm;
        border: 0.15mm dashed #a00;
        border-radius: 0.5mm;
      }
    `,
  });
}

// The ProdSpec logo is stored either as raw inline SVG markup or as a
// raster data URL ("data:image/png;base64,…" / jpeg) when the operator
// uploads a PNG/JPG. Render rasters via <img>; inline SVG goes straight
// into the DOM. Returns "" when no logo is set — no placeholder keeps
// the small label face clean.
function renderLogoBlock(logo: string | null | undefined): string {
  if (!logo || !logo.trim()) return "";
  const trimmed = logo.trim();
  if (trimmed.startsWith("data:")) {
    return `<div class="logo"><img src="${escapeHtml(trimmed)}" alt="" /></div>`;
  }
  return `<div class="logo">${logo}</div>`;
}
