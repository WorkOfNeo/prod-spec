import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'sok-license-price-sticker',
  customer: 'SOK',
  businessArea: 'License',
  printType: 'price-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'SOK-License-Price sticker.pdf',
  layoutFamily: 'price-sticker-sok',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 28, heightMm: 35 },
      fields: [
        { key: 'styleNumber', required: true, source: 'po', notes: 'Rendered \'Model no.…\' (License example HK60112; Private Label example IL12345)' },
        { key: 'sizes', required: true, source: 'po', notes: 'Single size per sticker, e.g. \'M\'' },
        { key: 'ean13', required: true, source: 'po', notes: 'Barcode with digits' },
        { key: 'composition', languages: ['FI', 'SV', 'ET'], required: true, source: 'article', notes: '\'100% Puuvilla\' (FI) + \'100% Bomull / 100% Puuvill\' (SV/ET)' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'No mm callouts — 28×35 mm are PLACEHOLDER dimensions from the Ge-kås price sticker analog; verify before production. Same layout for License and Private Label (only the example style number differs). No retail price on this sticker.',
};

export default spec;
