import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'dollarstore-private-label-polybag-sticker',
  customer: 'Dollarstore',
  businessArea: 'Private label',
  printType: 'polybag-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Dollarstore-Private label-POLYBAG STICKER.pdf',
  layoutFamily: 'polybag-dollarstore',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 105, heightMm: 75 },
      fields: [
        { key: 'customerItemNo', required: true, source: 'po' },
        { key: 'ean13', required: true, source: 'po', notes: 'Marker \'EAN Code\'' },
        { key: 'description', languages: ['EN'], required: false, source: 'po', notes: 'Not marked in template; present on the License assortment sticker — confirm' },
        { key: 'qtyPerCarton', required: false, source: 'po', notes: 'Not marked in template; present on the License assortment sticker (inner-box qty) — confirm' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'Field-marker template (markers: Customer Item No, EAN Code). The License sibling is the 105×75 mm assortment sticker — 105×75 mm are PLACEHOLDER dimensions from it; verify before production.',
};

export default spec;
