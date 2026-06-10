import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'tokmanni-private-label-polybag-sticker',
  customer: 'Tokmanni',
  businessArea: 'Private label',
  printType: 'polybag-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Tokmanni-Private label-POLYBAG STICKER.pdf',
  layoutFamily: 'polybag-tokmanni',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 60, heightMm: 50 },
      fields: [
        { key: 'customerItemNo', required: true, source: 'po' },
        { key: 'sizes', languages: ['FI', 'SV'], required: true, source: 'po', notes: 'Languages assumed from the License polybag sticker (FI/SV captions)' },
        { key: 'sizeRange', languages: ['FI', 'SV'], required: false, source: 'po', notes: 'Not marked in template; present on the License sibling — confirm' },
        { key: 'ean13', required: true, source: 'po', notes: 'Marker \'EAN Code\'' },
        { key: 'retailPrice', required: true, source: 'po', notes: 'Marker \'Retail Prices\' (EUR)' },
        { key: 'qtyPerCarton', required: false, source: 'po', notes: 'Not marked in template; present on the License sibling — confirm' },
      ],
    },
  ],
  dimensionsVerified: false,
  currency: 'EUR',
  notes: 'Field-marker template (markers: Customer Item No, Sizes, EAN Code, Retail Prices); content assumed to mirror the License polybag sticker (brief F10). No mm callouts — 60×50 mm are PLACEHOLDER dimensions from the License sibling; verify before production.',
};

export default spec;
