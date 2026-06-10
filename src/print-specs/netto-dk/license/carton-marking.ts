import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'netto-dk-license-carton-marking',
  customer: 'Netto DK',
  businessArea: 'License',
  printType: 'carton-marking',
  renderStrategy: 'dynamic',
  sourcePdf: 'Netto DK-License-Carton marking.pdf',
  layoutFamily: 'carton-marking-netto-dk',
  parts: [
    {
      id: 'box-label',
      dimensions: { widthMm: 105, heightMm: 148 },
      fields: [
        { key: 'ean128', required: true, source: 'po', notes: '\'EAN BARCODE (see PO) — has to be generated as EAN128\'; carton EAN as Code128, number printed under the bars' },
        { key: 'qtyPerCarton', required: true, source: 'po', notes: '\'Pcs. Per master\'' },
        { key: 'customerOrderNumber', required: false, source: 'po', notes: 'FOB orders print the customer\'s order number on the \'Order no. :\' row', value: { switch: 'deliveryTerm', cases: { FOB: { field: 'customerOrderNumber' } }, default: { field: 'poNumber' } } },
        { key: 'poNumber', required: true, source: 'po', notes: 'DDP orders print the Contrast order number (\'Order no. : C-PO…\')' },
        { key: 'description', required: false, source: 'article', notes: '\'Article: T-skjorte Grinchen\'' },
      ],
    },
  ],
  dimensions: { widthMm: 105, heightMm: 148 },
  dimensionsVerified: false,
  notes: 'Clean dynamic render of the box label — the source PDF is an annotated layout drawing (red field arrows, yellow FOB/DDP banners, internal comments) and must never be emitted as the print. Rows: Netto A/S, Pcs. Per master, Total no. Master Cartons (blank — warehouse fills in), Order no. (FOB → customer order number, DDP → Contrast order number), Article, Weight (blank). Print size per PO — 105×148 mm working default. Placement: centre of box, at least 30 mm from any edge.',
};

export default spec;
