import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'runsven-private-label-62951-care-label-layout',
  customer: 'Runsven',
  businessArea: 'Private Label',
  printType: 'care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Runsven-Private Label-62951 - care label layout.pdf',
  layoutFamily: 'care-label-square-3label',
  parts: [
    {
      id: 'label1',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'sizes', required: true, source: 'po', notes: 'Example: S/M, L/XL, XXL — one column per size' },
        { key: 'customerItemNo', required: true, source: 'po', notes: 'Rendered \'Item No : …\'' },
        { key: 'ean13', required: true, source: 'po', notes: 'EAN-13 under each size column' },
        { key: 'countryOfOrigin', languages: ['SV'], required: true, source: 'po', notes: 'Swedish COO + customer address block: \'Tillverkad i India för Runsven AB / Box 143, 596 23 Skänninge / Tlf.: +46(0)771 202 202 / kundtjanst@runsvengruppen.com\'' },
      ],
    },
    {
      id: 'label2-front',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'composition', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL', 'FR', 'PL'], required: true, source: 'article' },
        { key: 'washCareSymbols', required: true, source: 'article', notes: '\'40°\' symbol strip at the foot of label 2 front' },
      ],
    },
    {
      id: 'label2-back',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'careInstructions', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL'], required: true, source: 'article', notes: 'Continues on label 3 (front) with FR + PL' },
      ],
    },
    {
      id: 'label3-front',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'careInstructions', languages: ['FR', 'PL'], required: true, source: 'article', notes: 'Continuation from label 2 (back)' },
      ],
    },
    {
      id: 'label3-back',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'countryOfOrigin', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL', 'FR', 'PL'], required: true, source: 'po', notes: 'Single combined block, e.g. \'Made in India / Fremstillet i Indien / …\'' },
        { key: 'poNumber', required: true, source: 'po', notes: 'Rendered as \'PO No. C-PO…\'' },
      ],
    },
  ],
  dimensionsVerified: true,
  notes: '\'LABEL 1/2/3\' care label, Runsven variant: label 1 is 35×90 mm (not 35×45) and carries the Swedish COO + Runsven address block; labels 2-3 are 35×90 mm printed front/back. No Contrast supplier block in this layout.',
};

export default spec;
