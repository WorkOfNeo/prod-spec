import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'netto-dk-private-label-carton-marking',
  customer: 'Netto DK',
  businessArea: 'Private Label',
  printType: 'carton-marking',
  renderStrategy: 'dynamic',
  sourcePdf: 'Netto DK-Private Label-Carton marking.pdf',
  layoutFamily: 'carton-marking-netto-dk',
  parts: [
    {
      id: 'box-sticker',
      dimensions: { widthMm: 150, heightMm: 75 },
      fields: [
        { key: 'ean128', required: true, source: 'po', notes: 'Top-right corner, two elements: carton EAN from the PO PDF as EAN-128 bars, plus the EAN number printed beneath the bars' },
        { key: 'customerName', required: true, source: 'customer-master', notes: 'First row of the bottom-left block ("Netto A/S" in the reference)' },
        { key: 'qtyPerCarton', required: true, source: 'po', notes: '\'Pcs. Per master:\' — Pre-Order Qty/Carton column' },
        { key: 'customerOrderNumber', required: false, source: 'po', notes: 'FOB orders print the customer\'s order number on the \'Order no. :\' row' },
        { key: 'poNumber', required: true, source: 'po', notes: 'DDP orders print the Contrast order number (\'Order no. : C-PO…\')' },
        { key: 'description', required: false, source: 'po', notes: '\'Article:\' — Pre-Order Description column' },
      ],
    },
  ],
  dimensions: { widthMm: 150, heightMm: 75 },
  dimensionsVerified: false,
  notes: 'Clean dynamic render of the box sticker — the source PDF is an annotated layout drawing (red field arrows, yellow FOB/DDP banners, internal comments) and must never be emitted as the print. Top right: EAN-128 barcode of the carton EAN with the number printed under the bars. Bottom left, six rows: customer name, Pcs. Per master (Qty/Carton), Total no. Master Cartons (blank — warehouse pens it in), Order no. (FOB → customer order number, DDP → Contrast order number), Article (Description column), Weight (blank). Physical size not stated on the drawing — 150×75 mm working size taken from the drawing\'s ~2:1 sticker outline at 1:1 scale. Placement: centre of box, at least 30 mm from any edge.',
};

export default spec;
