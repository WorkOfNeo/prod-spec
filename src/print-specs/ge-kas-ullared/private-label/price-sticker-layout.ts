import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'ge-kas-ullared-private-label-price-sticker-layout',
  customer: 'Ge-kås Ullared',
  businessArea: 'Private label',
  printType: 'price-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Ge-kås Ullared-Private label-Price sticker layout.pdf',
  layoutFamily: 'price-sticker-ge-kas',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 28, heightMm: 35 },
      fields: [
        { key: 'sizes', required: true, source: 'po', notes: 'Size + full range, e.g. \'128 (128-170)\'; one sticker per size break (example shows 5)' },
        { key: 'customerItemNo', required: true, source: 'po', notes: 'Example \'B/GI20058\'' },
        { key: 'ean13', required: true, source: 'po', notes: 'Marker \'EAN Code\'' },
        { key: 'retailPrice', required: true, source: 'po', notes: 'Example \'129,00\' (SEK)' },
      ],
    },
  ],
  dimensionsVerified: true,
  currency: 'SEK',
  notes: 'Price sticker 28×35 mm (callouts \'28 mm\' / \'35 mm\'); one sticker per size break.',
};

export default spec;
