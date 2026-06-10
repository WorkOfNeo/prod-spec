import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'dollarstore-private-label-washcare-label',
  customer: 'Dollarstore',
  businessArea: 'Private label',
  printType: 'wash-care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Dollarstore-Private label-Washcare label.pdf',
  layoutFamily: 'wash-care-template-fieldmarkers',
  parts: [
    {
      id: 'label',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'sizes', required: true, source: 'po' },
        { key: 'ean13', required: true, source: 'po', notes: 'Five example EAN-13s in template — one per size' },
        { key: 'customerItemNo', required: true, source: 'po' },
        { key: 'customerOrderNumber', required: true, source: 'po' },
        { key: 'composition', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL', 'FR', 'PL'], required: true, source: 'article', notes: 'Languages assumed — brief F7: follows the F1 9-language set (License wash care). Template shows markers only' },
        { key: 'careInstructions', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL', 'FR', 'PL'], required: true, source: 'article', notes: 'Languages assumed — brief F7: follows the F1 9-language set. Template shows markers only' },
        { key: 'washCareSymbols', required: true, source: 'article' },
        { key: 'poNumber', required: true, source: 'po' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'Field-marker template (markers: Sizes, EAN Code, Customer Item No, Customer Order Number, Composition, PO Number, Wash Care Symbols, Care Instructions). No Country of Origin marker — the License version carries a 9-language COO block; confirm. No mm callouts — 35×90 mm are PLACEHOLDER dimensions from the F1 family.',
};

export default spec;
