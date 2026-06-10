import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'ottos-ag-zentrallager-license-sticker-for-hangtag',
  customer: 'Otto\'s AG Zentrallager',
  businessArea: 'License',
  printType: 'hangtag-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Otto\'s AG Zentrallager-License-Sticker for Hangtag.pdf',
  layoutFamily: 'hangtag-sticker-ottos',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 28, heightMm: 35 },
      fields: [
        { key: 'sizes', required: true, source: 'po', notes: 'Example \'72/B\'' },
        { key: 'prodNumber', required: true, source: 'po', notes: 'Marker \'Prod number\'' },
        { key: 'retailPrice', required: true, source: 'po', notes: 'Marker \'Retail Prices\'; currency not stated in layout and not representable in the spec currency union (Otto\'s is CH) — confirm' },
        { key: 'campaignWeek', required: true, source: 'po' },
        { key: 'ean13', required: true, source: 'po', notes: 'Marker \'EAN Code\'' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'Sticker for hangtag — field markers only (Sizes, Prod number, Retail Prices, Campaign Week, EAN Code). No mm callouts — 28×35 mm are PLACEHOLDER dimensions; verify before production. Currency not determinable from layout.',
};

export default spec;
