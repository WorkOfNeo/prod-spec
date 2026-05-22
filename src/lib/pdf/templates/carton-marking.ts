import type { StyleData } from "../types";
import { renderBarcodeDataUrl } from "../barcode";
import { escapeHtml, htmlDocument, tFor } from "./base";

export async function renderCartonMarkingHtml(style: StyleData): Promise<string> {
  const barcode = await renderBarcodeDataUrl(style.carton.ean13);
  const productEn = tFor(style.productNameTranslations, "en") || style.styleName;
  const productDe = tFor(style.productNameTranslations, "de") || productEn;

  const body = `
    <div class="page">
      <div class="label">${escapeHtml(style.customerName)}</div>
      <h1>${escapeHtml(productEn)}</h1>
      <h2>${escapeHtml(productDe)}</h2>

      <table style="margin-top: 8pt;">
        <tr><td class="label">KL No.</td><td>${escapeHtml(style.carton.klNumber)}</td>
            <td class="label">Supplier No.</td><td>${escapeHtml(style.carton.supplierNumber)}</td></tr>
        <tr><td class="label">Lot</td><td>${escapeHtml(style.carton.lot)}</td>
            <td class="label">Outer VE</td><td>${style.carton.outerVE}</td></tr>
        <tr><td class="label">Style</td><td>${escapeHtml(style.styleNumber)}</td>
            <td class="label">EAN</td><td>${escapeHtml(style.carton.ean13)}</td></tr>
      </table>

      <div class="barcode" style="margin-top: 12pt;"><img src="${barcode}" alt="Carton EAN" /></div>
    </div>
  `;

  return htmlDocument({ title: `Carton — ${style.styleName}`, body, pageSize: "A6" });
}
