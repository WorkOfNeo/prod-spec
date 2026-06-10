import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'tokmanni-license-polybag-sticker-layout',
  customer: 'Tokmanni',
  businessArea: 'License',
  printType: 'polybag-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Tokmanni-License-Polybag sticker layout.pdf',
  layoutFamily: 'polybag-tokmanni',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 60, heightMm: 50 },
      fields: [
        { key: 'customerItemNo', required: true, source: 'po', notes: 'Example \'A8-0185\'' },
        { key: 'sizes', languages: ['FI', 'SV'], required: true, source: 'po', notes: 'This pack\'s size under the caption \'KOKO/STORLEK:\'' },
        { key: 'sizeRange', languages: ['FI', 'SV'], required: true, source: 'po', notes: '\'Tästä tuotteesta saatavana koot: / Storlekar för denna produkt:\' + range, e.g. \'23/26-27/30-31/34\'' },
        { key: 'ean13', required: true, source: 'po', notes: 'Marker \'EAN Code\'; digits + bars' },
        { key: 'retailPrice', required: true, source: 'po', notes: 'Example \'6.99€\'' },
        { key: 'qtyPerCarton', required: true, source: 'po', notes: 'Pieces per polybag, example \'5 PCS\'' },
      ],
    },
  ],
  dimensionsVerified: true,
  currency: 'EUR',
  notes: 'Polybag sticker 60×50 mm (callouts \'60.00 mm\' / \'50.00 mm\'). Layout shows two articles × three sizes.',
};

export default spec;
