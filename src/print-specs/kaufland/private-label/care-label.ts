import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'kaufland-private-label-care-label',
  customer: 'Kaufland',
  businessArea: 'Private Label',
  printType: 'care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Kaufland-Private Label-Care label.pdf',
  layoutFamily: 'wash-care-kaufland-cee',
  parts: [
    {
      id: 'label',
      dimensions: { widthMm: 155, heightMm: 40 },
      fields: [
        { key: 'composition', languages: ['DE', 'CS', 'HR', 'RO', 'SK', 'BG'], required: true, source: 'article', notes: 'Languages assumed identical to Kaufland License (brief F6) — template shows markers only' },
        { key: 'careInstructions', languages: ['DE', 'CS', 'HR', 'RO', 'SK', 'BG'], required: false, source: 'article', notes: 'No \'Care Instructions\' marker in template; License layout carries a 6-language care text block — confirm' },
        { key: 'washCareSymbols', required: true, source: 'article' },
        { key: 'ean13', required: true, source: 'po', notes: 'Marker \'EAN Code\'; EAN-13 per size on the License sibling' },
        { key: 'countryOfOrigin', languages: ['DE', 'CS', 'HR', 'RO', 'SK', 'BG'], required: true, source: 'po', notes: 'Languages assumed identical to Kaufland License (brief F6)' },
        { key: 'poNumber', required: true, source: 'po' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'Field-marker template (markers: Composition, Wash Care Symbols, EAN Code, Country of Origin, PO Number). No mm callouts — 155×40 mm are PLACEHOLDER dimensions from the Kaufland License sibling; verify before production.',
};

export default spec;
