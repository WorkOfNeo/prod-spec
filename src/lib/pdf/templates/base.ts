import { barcodeFontCss, DEFAULT_BARCODE_FONT, encodeForFont, type BarcodeFontConfig } from "../barcode";

export type PageSize =
  | { kind: "preset"; preset: "A4" | "A5" | "A6" | "A7" | "A8" }
  | { kind: "mm"; widthMm: number; heightMm: number };

export function pageSizeCss(size: PageSize): string {
  if (size.kind === "preset") return size.preset;
  return `${size.widthMm}mm ${size.heightMm}mm`;
}


export function htmlDocument({
  title,
  pageSize = { kind: "preset", preset: "A4" },
  body,
  extraCss = "",
  barcodeFont = DEFAULT_BARCODE_FONT,
}: {
  title: string;
  // Accept either a structured PageSize or a raw CSS size string (e.g. "A4",
  // "80mm 120mm") for back-compat with templates that haven't migrated yet.
  pageSize?: PageSize | string;
  body: string;
  extraCss?: string;
  barcodeFont?: BarcodeFontConfig;
}): string {
  const sizeCss = typeof pageSize === "string" ? pageSize : pageSizeCss(pageSize);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  ${barcodeFontCss(barcodeFont)}
  @page { size: ${sizeCss}; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #000; }
  body { font-size: 9pt; line-height: 1.3; }
  .page { page-break-after: always; padding: 8mm; }
  .page:last-child { page-break-after: auto; }
  h1, h2, h3 { font-weight: 600; margin: 0 0 4pt; }
  table { border-collapse: collapse; width: 100%; }
  td, th { padding: 2pt 4pt; vertical-align: top; }
  .label { color: #666; font-size: 7pt; text-transform: uppercase; letter-spacing: 0.04em; }
  .barcode { text-align: center; }
  .barcode img { max-width: 100%; height: auto; }
  /* Font-face barcode rendering. Set --barcode-font-size per template to
     control the bar height (the font is purely vertical strokes). */
  .barcode-font {
    font-family: '${escapeCssString(barcodeFont.family)}', monospace;
    font-size: var(--barcode-font-size, 28pt);
    line-height: 1;
    letter-spacing: 0;
    display: inline-block;
  }
  .small { font-size: 7pt; }
  ${extraCss}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeCssString(s: string): string {
  return s.replace(/'/g, "\\'");
}

export function tFor(translations: Array<{ language: string; text: string }>, lang: string): string {
  return translations.find((t) => t.language === lang)?.text ?? "";
}

// Render a font-face barcode `<span>`. `barSize` is the CSS font-size that
// controls bar height — the font itself draws vertical strokes so a
// larger font-size = taller bars (and naturally wider too, scaling
// horizontally with the digit count).
export function fontBarcode(
  ean13: string,
  font: BarcodeFontConfig = DEFAULT_BARCODE_FONT,
  barSize = "28pt",
): string {
  const text = encodeForFont(ean13, font);
  // Inline style overrides --barcode-font-size for this single instance.
  return `<span class="barcode-font" style="--barcode-font-size: ${barSize}; font-family: '${escapeCssString(font.family)}', monospace;">${escapeHtml(text)}</span>`;
}
