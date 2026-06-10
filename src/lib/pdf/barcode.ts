import { toBuffer } from "bwip-js";

// =====================================================
// Barcode rendering — two paths:
//
// 1. @font-face barcode font (the new default, Phase 2).
//    `encodeForFont(ean, font)` returns the *text* to drop inside
//    `<span style="font-family: …">…</span>` — the font itself renders
//    the bars. Production-friendly because the output is pure HTML/CSS
//    and scales to any DPI Puppeteer asks for.
//
// 2. bwip-js PNG (the M2 path, retained for fallback + dev preview).
//    Used by manual entries and any template that hasn't been migrated.
// =====================================================

export type BarcodeFontConfig = {
  family: string;
  src: string;
};

// Default font: Libre Barcode EAN13 Text on Google Fonts. EAN13 variant
// (not Code128) because our barcodes are EAN-13 throughout the spec.
export const DEFAULT_BARCODE_FONT: BarcodeFontConfig = {
  family: "Libre Barcode EAN13 Text",
  src: "https://fonts.googleapis.com/css2?family=Libre+Barcode+EAN13+Text&display=block",
};

// Encode an EAN-13 string for rendering by the configured barcode font.
//
// - Libre Barcode EAN13 (Text): font renders the 13 digits as bars
//   automatically — no start/stop wrapping needed. Pass through verbatim.
// - Libre Barcode 128 (Text): font expects `*<text>*` sentinels.
// - Other / unknown families: pass through verbatim and let the operator
//   override per-customer.
export function encodeForFont(ean13: string, font: BarcodeFontConfig = DEFAULT_BARCODE_FONT): string {
  const fam = font.family.toLowerCase();
  if (fam.includes("128")) return `*${ean13}*`;
  // EAN8/EAN13/UPC/Code39 all expect raw text.
  return ean13;
}

// CSS `@font-face` snippet to import the configured font. If `src` is a
// Google Fonts CSS URL (`/css2?family=…`), we `@import` it directly. If
// it's a direct font-file URL we wrap it in a `@font-face` declaration.
// Anything else (relative path) we treat as a font file too.
export function barcodeFontCss(font: BarcodeFontConfig = DEFAULT_BARCODE_FONT): string {
  const isGoogleCssUrl = /fonts\.googleapis\.com\/css/i.test(font.src);
  if (isGoogleCssUrl) {
    return `@import url('${font.src}');`;
  }
  return `@font-face {
    font-family: '${escapeCssString(font.family)}';
    src: url('${font.src}');
    font-display: block;
  }`;
}

function escapeCssString(s: string): string {
  return s.replace(/'/g, "\\'");
}

// -----------------------------------------------------
// PNG fallback (bwip-js) — kept for the manual-entry preview path and as
// a safety net if a template hasn't been migrated to the font-face path.
// -----------------------------------------------------

export type BarcodeOpts = {
  bcid?: string;
  scale?: number;
  height?: number;
  includetext?: boolean;
  textxalign?: "center" | "left" | "right";
};

// No textxalign default: bwip-js's own EAN-13 default ("justify") produces
// the standard retail layout — first digit to the left of the symbol, two
// 6-digit groups sitting BETWEEN the extended guard bars. Forcing "center"
// (the old default) lumps all 13 digits centred across the guard bars and
// punches an unreadable white knockout through the symbol.
const DEFAULTS: Required<Pick<BarcodeOpts, "bcid" | "scale" | "height" | "includetext">> = {
  bcid: "ean13",
  scale: 3,
  height: 10,
  includetext: true,
};

export async function renderBarcodePng(text: string, opts: BarcodeOpts = {}): Promise<Buffer> {
  return toBuffer({ ...DEFAULTS, ...opts, text });
}

export async function renderBarcodeDataUrl(text: string, opts: BarcodeOpts = {}): Promise<string> {
  const buf = await renderBarcodePng(text, opts);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

// EAN-13 validity check — 13 digits, last is checksum.
export function isValidEan13(input: string): boolean {
  if (!/^\d{13}$/.test(input)) return false;
  const digits = input.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function computeEan13Checksum(twelve: string): string {
  if (!/^\d{12}$/.test(twelve)) throw new Error("EAN-13 base must be exactly 12 digits");
  const digits = twelve.split("").map(Number);
  const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  const check = (10 - (sum % 10)) % 10;
  return `${twelve}${check}`;
}
