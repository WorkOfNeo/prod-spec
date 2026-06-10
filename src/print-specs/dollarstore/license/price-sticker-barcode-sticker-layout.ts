import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'dollarstore-license-price-sticker-barcode-sticker-layout',
  customer: 'Dollarstore',
  businessArea: 'License',
  printType: 'price-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Dollarstore-License-Price sticker, Barcode sticker layout.pdf',
  layoutFamily: 'price-barcode-sticker-dollarstore',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 35, heightMm: 24 },
      fields: [
        { key: 'prodNumber', required: true, source: 'po', notes: 'Article code in header and rendered \'Prod. nr.: …\' beneath the barcode, e.g. \'PTQ10039\'' },
        { key: 'customerItemNo', required: true, source: 'po', notes: 'Marker \'Customer Item No\' points at the \'Prod. nr.\' line — same value as prodNumber in the example' },
        { key: 'retailPrice', required: true, source: 'po', notes: 'Dual price, e.g. \'89 SEK\' + \'59 DKK\'' },
        { key: 'composition', languages: ['SV', 'DA'], required: true, source: 'article', notes: 'e.g. \'100% Bomull / 100% Bomuld\'' },
        { key: 'washCareSymbols', required: true, source: 'article' },
        { key: 'ean13', required: true, source: 'po', notes: 'Digits printed, e.g. 5706323570934' },
      ],
    },
  ],
  dimensionsVerified: true,
  currency: 'SEK',
  notes: 'Combined price/barcode sticker 35×24 mm (callouts \'35 mm\' / \'24 mm\'). Dual retail price SEK + DKK — currency field set to SEK, DKK is the secondary price. Six example articles in layout.',
};

export default spec;
