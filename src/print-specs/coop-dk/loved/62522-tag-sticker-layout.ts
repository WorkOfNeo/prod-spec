import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'coop-dk-loved-62522-tag-sticker-layout',
  customer: 'Coop DK',
  businessArea: 'Loved',
  printType: 'tag-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Coop DK-Loved-62522 - tag sticker layout.pdf',
  layoutFamily: 'tag-sticker-coop-loved',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 35, heightMm: 60 },
      fields: [
        { key: 'styleNumber', required: true, source: 'po', notes: 'Row label per style, e.g. \'LV60127\'' },
        { key: 'sizes', required: true, source: 'po', notes: 'Example grid: S/M, L/XL, 2XL' },
        { key: 'composition', languages: ['DA'], required: true, source: 'article', notes: 'Example \'95% Viskose / 5% Elasthan\'' },
        { key: 'washCareSymbols', required: true, source: 'article', notes: '\'30°\' symbols' },
        { key: 'customerItemNo', required: true, source: 'po', notes: 'Two codes per sticker in example: \'1000538761\' + \'3702/2629\'' },
        { key: 'campaignWeek', required: false, source: 'po', notes: 'Marker present; value not visible in example — confirm' },
        { key: 'countryOfOrigin', languages: ['DA'], required: false, source: 'po', notes: 'Marker present; value not visible in example — confirm' },
        { key: 'retailPrice', required: true, source: 'po', notes: 'Example \'129,95\' (DKK)' },
      ],
    },
  ],
  dimensionsVerified: false,
  currency: 'DKK',
  notes: 'Tag sticker laid out as a grid of 3 styles × 3 sizes in the example. No EAN barcode marker in this layout. No mm callouts — 35×60 mm are PLACEHOLDER dimensions from the Coop price tag analog; verify before production.',
};

export default spec;
