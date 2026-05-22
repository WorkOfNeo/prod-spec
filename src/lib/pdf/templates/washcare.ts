import type { StyleData, WashSymbolCode } from "../types";
import { renderBarcodeDataUrl } from "../barcode";
import { escapeHtml, htmlDocument, tFor } from "./base";

// Wash-care symbols rendered as Unicode characters as a placeholder.
// M2 replace: embed actual ISO 3758 / GINETEX symbol set (SVG or font).
const SYMBOL_GLYPHS: Record<WashSymbolCode, string> = {
  wash30: "30°",
  wash40: "40°",
  wash60: "60°",
  wash_hand: "✋",
  wash_no: "✕",
  bleach_no: "△✕",
  bleach_oxygen: "△O",
  tumble_low: "▢•",
  tumble_normal: "▢••",
  tumble_no: "▢✕",
  iron_low: "⏵•",
  iron_medium: "⏵••",
  iron_high: "⏵•••",
  iron_no: "⏵✕",
  dryclean: "○P",
  dryclean_no: "○✕",
};

const LANGUAGES_FOR_WASHCARE: Array<"en" | "de" | "da"> = ["en", "de", "da"];

export async function renderWashcareHtml(style: StyleData): Promise<string> {
  const pages = await Promise.all(
    style.sizes.map(async (size) => {
      const barcode = await renderBarcodeDataUrl(size.ean13);
      return washcarePage(style, size.label, barcode);
    }),
  );
  return htmlDocument({
    title: `Washcare — ${style.styleName}`,
    pageSize: "A7",
    body: pages.join("\n"),
    extraCss: `
      .page { padding: 4mm; font-size: 7pt; }
      .symbols { display: flex; gap: 4pt; font-size: 11pt; margin: 4pt 0; }
      .composition { margin-top: 4pt; }
      .composition .row { margin-bottom: 2pt; }
      .composition .lang { font-weight: 600; }
    `,
  });
}

function washcarePage(style: StyleData, sizeLabel: string, barcodeDataUrl: string): string {
  const symbols = style.washSymbols.map((c) => SYMBOL_GLYPHS[c]).filter(Boolean).join(" ");
  const composition = LANGUAGES_FOR_WASHCARE.map((lang) => {
    const text = tFor(style.composition, lang);
    if (!text) return "";
    return `<div class="row"><span class="lang">${lang.toUpperCase()}</span> — ${escapeHtml(text)}</div>`;
  }).filter(Boolean).join("");

  return `
    <div class="page">
      <div class="label">${escapeHtml(style.customerName)}</div>
      <h2>${escapeHtml(style.styleName)} · Size ${escapeHtml(sizeLabel)}</h2>
      <div class="symbols">${symbols}</div>
      <div class="composition">${composition}</div>
      <div class="barcode" style="margin-top: 4pt;"><img src="${barcodeDataUrl}" alt="EAN ${escapeHtml(style.sizes.find((s) => s.label === sizeLabel)?.ean13 ?? "")}" /></div>
    </div>
  `;
}
