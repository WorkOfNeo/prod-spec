import type { StyleData } from "../../types";
import type { OutputDims } from "../../template-registry";
import type { PrintSpec, ValueRule } from "@/print-specs/shared/types";
import { escapeHtml, htmlDocument, tFor } from "../base";
import { renderBarcodeDataUrl } from "../../barcode";
import { findFieldRule, resolveFieldValue } from "../../spec-fields";

// netto-dk-privatelabel · Carton Marking — the master-carton box sticker.
//
// Reference: "Netto DK-*-Carton marking.pdf". That PDF is an annotated
// layout DRAWING (red field-marker arrows, yellow FOB/DDP banners, internal
// placement comments) — none of that may appear on the print. Field sources
// confirmed in the 2026-06 walkthrough with Niels:
//
//   ┌─────────────────────────────────────────────┐
//   │                          ▐█▌█▐██▌█▐█▌        │  EAN-128 bars (carton EAN
//   │                           5701234567890      │  from the PO PDF) + the
//   │                                              │  EAN number beneath
//   │ <customerName>                               │
//   │ Pcs. Per master:        <Qty/Carton>         │
//   │ Total no. Master Cartons:                    │  blank — penned in at the
//   │ Order no. :             <order no>           │  warehouse
//   │ Article:                <Description>        │
//   │ Weight:                                      │  blank
//   └─────────────────────────────────────────────┘
//
// • Brand row: StyleData.customerName (the style's Customer record —
//   "Netto A/S" on the reference drawing).
// • Pcs. Per master: Pre-Order Qty/Carton (carton.outerVE).
// • Order no. — FOB orders print the CUSTOMER's order number
//   (style.customerOrderNo); DDP orders print the CONTRAST order number
//   (style.poNumber, "C-PO…"). Picked by the style's delivery term; an
//   empty/unknown term defaults to DDP, since poNumber is always present.
//   The printed row label is "Order no. :" either way, as on the artwork.
// • Article: Pre-Order Description column (falls back to the EN product
//   name, then the style name, rather than printing an empty row).
//
// Barcode — "(see PO) has to be generated as EAN128". The carton EAN is
// rendered as Code 128 bars (bwip-js bcid "code128") with the number as a
// separate line under the bars, matching the artwork's "EAN NUMBER"
// placement. Some customers want a true EAN-13 instead — the ProdSpec
// output row's carton-barcode preference (style.cartonBarcode, applied by
// applyCartonBarcodePrefs) switches the symbology and/or bar height per
// spec; absent preference keeps the EAN-128 default. (If GS1-128 with
// application identifiers is ever required, switch the bcid to "gs1-128"
// and prefix an AI.)
//
// Print size: not stated on the drawing — the spec's 150×75 mm working
// size matches the drawing's ~2:1 sticker outline. The layout is
// dims-driven and tolerates other sticker sizes.
// The order-number binding, as a declarative rule: FOB → customer's order
// number; otherwise (DDP / DDU / DAP / empty) → Contrast PO. Spec files can
// override it on their `customerOrderNumber` field; this is the fallback so
// the hand-built registry entry behaves identically without a spec.
export const ORDER_NO_RULE: ValueRule = {
  switch: "deliveryTerm",
  cases: { FOB: { field: "customerOrderNumber" } },
  default: { field: "poNumber" },
};

export async function renderNettoCartonMarkingHtml(
  style: StyleData,
  dims: OutputDims,
  spec?: PrintSpec,
): Promise<string> {
  const pageSize = { kind: "mm" as const, widthMm: dims.widthMm, heightMm: dims.heightMm };

  const article =
    style.description || tFor(style.productNameTranslations, "en") || style.styleName;

  // Declarative order-no binding — spec rule wins, ORDER_NO_RULE otherwise.
  const orderNo = resolveFieldValue(
    findFieldRule(spec, "customerOrderNumber") ?? ORDER_NO_RULE,
    style,
  );

  const cartonEan = style.carton.ean13;
  const hasEan = !!cartonEan && cartonEan !== "0000000000000";
  // Per-spec barcode preference (ProdSpec output row, applied via
  // applyCartonBarcodePrefs): EAN-128 = Code 128 bars + the number printed
  // beneath (the default); EAN-13 = true EAN-13 with its digits inside the
  // symbol — no separate number row, it would print the digits twice.
  // heightMm overrides the classic 16 mm bars.
  const barcodeType = style.cartonBarcode?.type ?? "ean128";
  const barHeightMm = style.cartonBarcode?.heightMm ?? 16;
  let barcodeHtml: string;
  if (!hasEan) {
    barcodeHtml = `<div class="barcode-missing">No carton EAN configured</div>`;
  } else {
    try {
      const dataUrl =
        barcodeType === "ean13"
          ? await renderBarcodeDataUrl(cartonEan, { bcid: "ean13", scale: 3, height: barHeightMm, includetext: true })
          : await renderBarcodeDataUrl(cartonEan, { bcid: "code128", scale: 4, height: barHeightMm, includetext: false });
      const numberRow =
        barcodeType === "ean128"
          ? `
          <div class="ean-number">${escapeHtml(cartonEan)}</div>`
          : "";
      barcodeHtml = `
        <div class="ean">
          <img src="${dataUrl}" alt="${escapeHtml(cartonEan)}" />${numberRow}
        </div>`;
    } catch {
      barcodeHtml = `<div class="barcode-missing">EAN ${escapeHtml(cartonEan)} — could not encode</div>`;
    }
  }

  // "Total no. Master Cartons" and "Weight" have no source in our data model
  // — printed as empty rows for the warehouse to complete, matching the
  // reference form.
  const body = `
    <div class="page">
      <div class="box">
        <div class="barcode-area">${barcodeHtml}</div>
        <div class="rows">
          <div class="row brand">${escapeHtml(style.customerName)}</div>
          <div class="row"><span class="k">Pcs. Per master:</span><span>${escapeHtml(String(style.carton.outerVE || ""))}</span></div>
          <div class="row"><span class="k">Total no. Master Cartons:</span></div>
          <div class="row"><span class="k">Order no. :</span><span>${escapeHtml(orderNo)}</span></div>
          <div class="row"><span class="k">Article:</span><span>${escapeHtml(article)}</span></div>
          <div class="row"><span class="k">Weight:</span></div>
        </div>
      </div>
    </div>`;

  return htmlDocument({
    title: `Carton Marking — ${style.styleName}`,
    pageSize,
    body,
    barcodeFont: style.barcodeFont,
    extraCss: `
      .page { padding: 2mm; height: ${dims.heightMm}mm; display: flex; }
      .box {
        border: 0.5mm solid #000;
        flex: 1;
        padding: 3.5mm 4mm;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      /* Top-right: bars with the EAN number centred beneath them. */
      .barcode-area { align-self: flex-end; max-width: 80%; }
      .ean { display: inline-block; text-align: center; }
      .ean img { display: block; height: ${barHeightMm}mm; width: auto; max-width: 100%; }
      .ean-number { margin-top: 1mm; font-size: 10pt; letter-spacing: 0.08em; }
      /* Bottom-left block, pushed to the bottom edge. All rows are bold on
         the reference; ".k" not ".label" — the htmlDocument base sheet
         styles .label as small grey uppercase. */
      .rows { margin-top: auto; font-weight: 700; font-size: 10.5pt; }
      .row { padding: 0.8mm 0; }
      .row .k { display: inline-block; min-width: 26mm; padding-right: 3mm; }
      .row.brand { font-size: 11.5pt; }
      .barcode-missing {
        font-size: 8pt; color: #a00; text-align: center; padding: 2mm;
        border: 0.2mm dashed #a00; border-radius: 1mm;
      }
    `,
  });
}
