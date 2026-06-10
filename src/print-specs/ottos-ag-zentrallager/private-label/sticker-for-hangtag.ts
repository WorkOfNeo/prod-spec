import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'ottos-ag-zentrallager-private-label-sticker-for-hangtag',
  customer: 'Otto\'s AG Zentrallager',
  businessArea: 'Private label',
  printType: 'hangtag-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Otto\'s AG Zentrallager-Private label-Sticker for Hangtag.pdf',
  layoutFamily: 'hangtag-sticker-ottos',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 28, heightMm: 35 },
      fields: [
        { key: 'sizes', required: true, source: 'po' },
        { key: 'retailPrice', required: true, source: 'po', notes: 'Marker \'Retail Prices\'; currency not stated in layout and not representable in the spec currency union (Otto\'s is CH) — confirm' },
        { key: 'campaignWeek', required: true, source: 'po' },
        { key: 'ean13', required: true, source: 'po', notes: 'Marker \'EAN Code\'' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'Sticker for hangtag — field markers only (Sizes, Retail Prices, Campaign Week, EAN Code; no Prod number marker, unlike the License version). No mm callouts — 28×35 mm are PLACEHOLDER dimensions; verify before production. Currency not determinable from layout.',
};

export default spec;
