import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'coop-dk-license-62897-price-tag-layout',
  customer: 'Coop DK',
  businessArea: 'License',
  printType: 'price-tag',
  renderStrategy: 'dynamic',
  sourcePdf: 'Coop DK-License-62897 - price tag layout.pdf',
  layoutFamily: 'price-tag-coop-dk',
  parts: [
    {
      id: 'tag',
      dimensions: { widthMm: 35, heightMm: 60 },
      fields: [
        { key: 'campaignWeek', required: true, source: 'po', notes: 'Example code \'C182813\' in top row' },
        { key: 'sizeRange', required: true, source: 'po', notes: 'Marker \'Sizes\'; rendered as the full range \'Str.: S - M - L - XL - XXL\'' },
        { key: 'composition', languages: ['DA'], required: true, source: 'article', notes: 'Example \'100% Bomuld\'' },
        { key: 'customerItemNo', required: true, source: 'po', notes: 'Example \'3702/2644\'' },
        { key: 'ean13', required: true, source: 'po', notes: 'Digits + bars, e.g. 5706323585310' },
        { key: 'countryOfOrigin', languages: ['DA'], required: true, source: 'po', notes: '\'Produceret i Indien\'' },
        { key: 'retailPrice', required: true, source: 'po', notes: 'Rendered \'PER SÆT:KR 179,95\' (DKK)' },
      ],
    },
  ],
  dimensionsVerified: true,
  currency: 'DKK',
  notes: 'Price tag 35×60 mm (callouts \'35.00 mm\' / \'60.00 mm\').',
};

export default spec;
