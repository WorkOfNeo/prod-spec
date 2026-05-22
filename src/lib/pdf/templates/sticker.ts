import type { StyleData } from "../types";
import { renderBarcodeDataUrl } from "../barcode";
import { escapeHtml, htmlDocument } from "./base";

// Loved variant prints a price tag instead of a barcode sticker.
export async function renderStickerHtml(style: StyleData): Promise<string> {
  const isLoved = style.businessArea === "LOVED";
  const pages = await Promise.all(
    style.sizes.map(async (size) =>
      isLoved
        ? priceTagPage(style, size.label)
        : barcodeStickerPage(style, size.label, await renderBarcodeDataUrl(size.ean13)),
    ),
  );
  return htmlDocument({
    title: `Sticker — ${style.styleName}`,
    pageSize: "A7",
    body: pages.join("\n"),
    extraCss: `
      .page { padding: 4mm; }
      .price { font-size: 22pt; font-weight: 700; text-align: center; margin-top: 8pt; }
      .style-line { text-align: center; font-size: 9pt; margin-top: 2pt; }
    `,
  });
}

function barcodeStickerPage(style: StyleData, sizeLabel: string, barcodeDataUrl: string): string {
  return `
    <div class="page">
      <div class="label">${escapeHtml(style.customerName)}</div>
      <h3>${escapeHtml(style.styleName)}</h3>
      <div class="small">Style ${escapeHtml(style.styleNumber)} · Size ${escapeHtml(sizeLabel)}</div>
      <div class="barcode" style="margin-top: 6pt;"><img src="${barcodeDataUrl}" alt="EAN" /></div>
    </div>
  `;
}

function priceTagPage(style: StyleData, sizeLabel: string): string {
  const price = style.price
    ? `${style.price.amount.toFixed(2)} ${style.price.currency}`
    : "—";
  return `
    <div class="page">
      <div class="label">${escapeHtml(style.customerName)}</div>
      <h3>${escapeHtml(style.styleName)}</h3>
      <div class="price">${escapeHtml(price)}</div>
      <div class="style-line">Style ${escapeHtml(style.styleNumber)} · Size ${escapeHtml(sizeLabel)}</div>
    </div>
  `;
}
