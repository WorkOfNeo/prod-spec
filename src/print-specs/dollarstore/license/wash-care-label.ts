import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'dollarstore-license-wash-care-label',
  customer: 'Dollarstore',
  businessArea: 'License',
  printType: 'wash-care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Dollarstore-License-Wash Care Label.pdf',
  layoutFamily: 'wash-care-3sheet-35x90',
  parts: [
    {
      id: 'sheet1',
      dimensions: { widthMm: 35, heightMm: 50 },
      fields: [
        { key: 'sizes', required: true, source: 'po', notes: 'Header \'Size / Stl / Str\'; one column per size' },
        { key: 'ean13', required: true, source: 'po', notes: 'EAN-13 under each size; digits printed above the bars' },
        { key: 'customerItemNo', required: true, source: 'po', notes: 'Rendered \'Prod. Nr: …\'' },
        { key: 'customerOrderNumber', required: true, source: 'po', notes: 'Rendered \'Order nr : …\'' },
      ],
    },
    {
      id: 'sheet2-front',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'composition', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL', 'FR', 'PL'], required: true, source: 'article' },
        { key: 'washCareSymbols', required: true, source: 'article' },
      ],
    },
    {
      id: 'sheet2-back',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'careInstructions', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL'], required: true, source: 'article', notes: 'Continues on sheet 3 (front) with FR + PL' },
      ],
    },
    {
      id: 'sheet3-front',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'careInstructions', languages: ['FR', 'PL'], required: true, source: 'article', notes: 'Continuation from sheet 2 (back)' },
        { key: 'countryOfOrigin', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL', 'FR', 'PL'], required: true, source: 'po', notes: 'Single combined block, e.g. \'Made in India / Fremstillet i Indien / …\'' },
      ],
    },
    {
      id: 'sheet3-back',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'poNumber', required: true, source: 'po', notes: 'Rendered as \'PO No. C-PO…\'' },
      ],
    },
  ],
  dimensionsVerified: true,
  notes: 'Sewn wash care label, Dollarstore variant of the 35×90 family: sheet 1 is 35×50 mm (callout), sheets 2-3 are 35×90 mm, printed front/back. One sheet-1 block per style/colourway (example shows three styles). No Oeko-Tex marker in this layout.',
};

export default spec;
