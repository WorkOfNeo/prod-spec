import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'europris-t2c-po62740-polybag-sticker-2026-5-13',
  customer: 'Europris',
  businessArea: 'T2C',
  printType: 'polybag-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Europris-T2C-PO62740  polybag sticker 2026.5.13.pdf',
  layoutFamily: 'polybag-europris',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 105, heightMm: 75 },
      fields: [
        { key: 'customerOrderNumber', required: true, source: 'po' },
        { key: 'customerItemNo', required: true, source: 'po' },
        { key: 'description', languages: ['EN'], required: true, source: 'po', notes: 'Marker \'Description\'; colour comes via the separate \'Color Name From Client\' marker — no dedicated colour field key, capture colour in the description' },
        { key: 'sizes', required: true, source: 'po' },
        { key: 'qtyPerCarton', required: true, source: 'po', notes: 'Marker \'Qty/Carton\'' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'Field-marker template (markers: Customer Order Number, Customer Item No, Description, Sizes, Color Name From Client, Qty/Carton). No mm callouts — 105×75 mm are PLACEHOLDER dimensions (assortment-sticker analog); verify before production.',
};

export default spec;
