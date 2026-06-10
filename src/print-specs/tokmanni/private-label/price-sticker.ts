import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'tokmanni-private-label-price-sticker',
  customer: 'Tokmanni',
  businessArea: 'Private label',
  printType: 'price-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Tokmanni-Private label-PRICE STICKER.pdf',
  layoutFamily: 'price-sticker-tokmanni',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 28, heightMm: 35 },
      fields: [
        { key: 'customerItemNo', required: true, source: 'po' },
        { key: 'sizes', required: true, source: 'po' },
        { key: 'ean13', required: true, source: 'po', notes: 'Marker \'EAN Code\'' },
        { key: 'retailPrice', required: true, source: 'po', notes: 'Marker \'Retail Prices\' (EUR)' },
      ],
    },
  ],
  dimensionsVerified: false,
  currency: 'EUR',
  notes: 'Field-marker template (markers: Customer Item No, Sizes, EAN Code, Retail Prices). No mm callouts — 28×35 mm are PLACEHOLDER dimensions; verify before production.',
};

export default spec;
