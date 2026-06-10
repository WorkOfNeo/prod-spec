import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'dollarstore-private-label-barcode-sticker',
  customer: 'Dollarstore',
  businessArea: 'Private label',
  printType: 'barcode-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Dollarstore-Private label-Barcode sticker.pdf',
  layoutFamily: 'barcode-sticker-dollarstore-pl',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 35, heightMm: 24 },
      fields: [
        { key: 'composition', languages: ['SV', 'DA'], required: true, source: 'article', notes: 'Languages assumed from the Dollarstore License price/barcode sticker — template shows markers only; confirm' },
        { key: 'washCareSymbols', required: true, source: 'article' },
        { key: 'ean13', required: true, source: 'po', notes: 'Marker \'EAN Code\'' },
        { key: 'customerItemNo', required: true, source: 'po' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'Field-marker template (markers: Composition, Wash Care Symbols, EAN Code, Customer Item No). No mm callouts — 35×24 mm are PLACEHOLDER dimensions from the Dollarstore License price/barcode sticker; verify before production.',
};

export default spec;
