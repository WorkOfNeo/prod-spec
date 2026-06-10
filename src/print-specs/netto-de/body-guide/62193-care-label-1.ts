import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'netto-de-body-guide-62193-care-label-1',
  customer: 'Netto DE',
  businessArea: 'Body Guide',
  printType: 'care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Netto DE-Body Guide-62193 - Care label 1.pdf',
  layoutFamily: 'care-label-netto-de',
  parts: [
    {
      id: 'sheet1',
      dimensions: { widthMm: 35, heightMm: 40 },
      fields: [
        { key: 'sizes', required: true, source: 'po', notes: 'Per-colourway size blocks; example \'62/68, 74/80, 86/92\' repeated for COL ROSE and COL NAVY' },
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
        { key: 'supplierAddress', required: true, source: 'customer-master', notes: 'Contrast block: \'Rudolfgårdsvej 6A - 8260 Viby J - DK / www.contrast.dk/info@contrast.dk\'' },
      ],
    },
  ],
  dimensionsVerified: true,
  notes: 'Two-part care label: sheet 1 is 35×40 mm (\'Width- 35mm, finished length- 40mm\'), sheets 2-3 are 35×90 mm (\'Width- 35mm, finished length- 90mm\'), printed front/back. No barcode on this label. Quality: \'White soft Stain, no burned edges\'.',
};

export default spec;
