import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'coop-dk-license-62897-care-label-layout',
  customer: 'Coop DK',
  businessArea: 'License',
  printType: 'care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Coop DK-License-62897 - care label layout.pdf',
  layoutFamily: 'care-label-square-3label',
  parts: [
    {
      id: 'label1',
      dimensions: { widthMm: 35, heightMm: 45 },
      fields: [
        { key: 'sizes', required: true, source: 'po', notes: 'Example shows 5 size breaks (S-XXL), one column per size' },
        { key: 'customerItemNo', required: true, source: 'po', notes: 'Example \'3702/2644\'' },
        { key: 'ean13', required: true, source: 'po', notes: 'EAN-13 under each size column' },
        { key: 'campaignWeek', required: false, source: 'po', notes: 'Marker \'Campaign Week\' on label 1; exact placement ambiguous in layout — confirm (cf. price tag campaign code \'C182813\')' },
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
        { key: 'careInstructions', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL'], required: true, source: 'article', notes: 'Continues on label 3 (front) with FR + PL. Layout shows the full 9-language set; brief flagged only EN/DA/DE/PL as visible — all 9 confirmed from PDF text.' },
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
        { key: 'supplierAddress', required: true, source: 'customer-master', notes: 'Contrast block: \'Rudolfgårdsvej 6A - 8260 Viby J - DK / www.contrast.dk/info@contrast.dk\'' },
      ],
    },
  ],
  dimensionsVerified: true,
  notes: '\'LABEL 1/2/3\' care label (square layout doc): label 1 is 35×45 mm single-sided; labels 2-3 are 35×90 mm printed front/back.',
};

export default spec;
