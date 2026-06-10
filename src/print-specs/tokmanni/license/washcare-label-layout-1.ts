import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'tokmanni-license-washcare-label-layout-1',
  customer: 'Tokmanni',
  businessArea: 'License',
  printType: 'wash-care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Tokmanni-License-WASHCARE LABEL LAYOUT (1).pdf',
  layoutFamily: 'wash-care-template-fieldmarkers',
  parts: [
    {
      id: 'label',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'sizes', required: true, source: 'po' },
        { key: 'customerItemNo', required: true, source: 'po' },
        { key: 'ean13', required: true, source: 'po', notes: 'Marker \'EAN Code\'; EAN-13 per brief rule for care/wash care labels' },
        { key: 'countryOfOrigin', languages: ['FI', 'SV'], required: true, source: 'po', notes: 'Languages assumed FI + SV (brief F7 / translation mapping) — template shows markers only' },
        { key: 'composition', languages: ['FI', 'SV'], required: true, source: 'article', notes: 'Languages assumed FI + SV (brief F7 / translation mapping) — template shows markers only' },
        { key: 'careInstructions', languages: ['FI', 'SV'], required: false, source: 'article', notes: 'No marker in template — assumed from translation mapping; confirm' },
        { key: 'washCareSymbols', required: true, source: 'article' },
        { key: 'poNumber', required: true, source: 'po' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'Field-marker template (markers: Sizes, Customer Item No, EAN Code, Country of Origin, Composition, PO Number, Wash Care Symbols). No mm callouts — 35×90 mm are PLACEHOLDER dimensions from the F1 wash-care family. Sheet/fold structure not specified in the template — confirm before production.',
};

export default spec;
