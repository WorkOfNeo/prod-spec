import type { StyleData } from "../../types";
import type { OutputDims } from "../../template-registry";
import { escapeHtml, htmlDocument, tFor } from "../base";
import { renderBarcodeDataUrl } from "../../barcode";

// netto-dk-privatelabel · Carton Marking — the master-carton box label.
// Reference: "Carton marking.pdf". Placed centred on the box, ≥30 mm from
// any edge. Carries the customer (Netto A/S), the article name, per-carton
// quantities, the order number, and the carton EAN as a Code128 barcode.
//
// FOB vs DDP — the reference shows two variants of the order-number row:
//   FOB orders print the CUSTOMER's order number (style.customerOrderNo)
//   DDP orders print the CONTRAST order number (style.poNumber, "C-PO…")
// We pick by the style's delivery term (mapped from the Pre-Order board);
// an empty/unknown term defaults to DDP, since poNumber is always present.
//
// Barcode — "(see PO) has to be generated as EAN128". The carton EAN number
// is rendered as a Code128 (bwip-js bcid "code128") PNG. (If GS1-128 with
// application identifiers is ever required, switch the bcid to "gs1-128".)
export async function renderNettoCartonMarkingHtml(
  style: StyleData,
  dims: OutputDims,
): Promise<string> {
  const pageSize = { kind: "mm" as const, widthMm: dims.widthMm, heightMm: dims.heightMm };

  const article = tFor(style.productNameTranslations, "en") || style.styleName;

  // FOB → customer's order number; otherwise (DDP / empty) → Contrast PO.
  const isFob = (style.deliveryTerm ?? "").toUpperCase().includes("FOB");
  const orderNo = (isFob ? style.customerOrderNo : style.poNumber) ?? "";
  const orderLabel = isFob ? "Customer Order No." : "Contrast Order No.";

  const cartonEan = style.carton.ean13;
  const hasEan = !!cartonEan && cartonEan !== "0000000000000";
  let barcodeHtml: string;
  if (!hasEan) {
    barcodeHtml = `<div class="barcode-missing">No carton EAN configured</div>`;
  } else {
    try {
      const dataUrl = await renderBarcodeDataUrl(cartonEan, {
        bcid: "code128",
        scale: 3,
        height: 14,
        includetext: true,
        textxalign: "center",
      });
      barcodeHtml = `<img src="${dataUrl}" alt="${escapeHtml(cartonEan)}" />`;
    } catch {
      barcodeHtml = `<div class="barcode-missing">EAN ${escapeHtml(cartonEan)} — could not encode</div>`;
    }
  }

  // "Total no. Master Cartons" and "Weight" have no source in our data model
  // — printed as blank fill-in rows for the warehouse to complete, matching
  // the reference form.
  const blank = `<span class="fill-in"></span>`;

  const body = `
    <div class="page">
      <div class="brand">${escapeHtml(style.customerName)}</div>
      <h1>${escapeHtml(article)}</h1>

      <table>
        <tr><td class="label">${escapeHtml(orderLabel)}</td><td>${escapeHtml(orderNo) || blank}</td></tr>
        <tr><td class="label">Pcs. Per Master</td><td>${escapeHtml(String(style.carton.outerVE || ""))}</td></tr>
        <tr><td class="label">Total no. Master Cartons</td><td>${blank}</td></tr>
        <tr><td class="label">Weight</td><td>${blank}</td></tr>
        <tr><td class="label">Style</td><td>${escapeHtml(style.styleNumber)}</td></tr>
      </table>

      <div class="ean">
        <div class="ean-no">EAN: ${hasEan ? escapeHtml(cartonEan) : "—"}</div>
        <div class="barcode">${barcodeHtml}</div>
      </div>

      <div class="note">Box marking — centre of box, ≥30 mm from each edge.</div>
    </div>`;

  return htmlDocument({
    title: `Carton — ${style.styleName}`,
    pageSize,
    body,
    barcodeFont: style.barcodeFont,
    extraCss: `
      .page { padding: 10mm; display: flex; flex-direction: column; height: 100%; }
      .brand { font-size: 12pt; font-weight: 700; letter-spacing: 0.02em; }
      h1 { font-size: 16pt; font-weight: 700; margin: 2mm 0 4mm; }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 1.6mm 2mm; vertical-align: bottom; border-bottom: 0.2mm solid #ddd; font-size: 10pt; }
      td.label { color: #555; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.04em; width: 45%; }
      .fill-in { display: inline-block; min-width: 30mm; border-bottom: 0.2mm solid #999; height: 1em; }
      .ean { margin-top: auto; padding-top: 6mm; text-align: center; }
      .ean-no { font-size: 9pt; letter-spacing: 0.05em; margin-bottom: 1.5mm; }
      .barcode img { display: block; width: 80%; max-width: 80%; height: auto; margin: 0 auto; }
      .barcode-missing {
        font-size: 8pt; color: #a00; text-align: center; padding: 2mm;
        border: 0.2mm dashed #a00; border-radius: 1mm;
      }
      .note { margin-top: 4mm; font-size: 6.5pt; color: #888; text-align: center; }
    `,
  });
}
