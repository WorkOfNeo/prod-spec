import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'netto-dk-body-guide-wash-care-label',
  customer: 'Netto DK',
  businessArea: 'Body Guide',
  printType: 'wash-care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Netto DK-Body Guide-Wash care label.pdf',
  layoutFamily: 'wash-care-3sheet-35x90',
  parts: [
    {
      id: 'sheet1',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'sizes', required: true, source: 'po', notes: 'Header \'Size / Stl / Str\'; size range per PO (\'Size Range: Refer PO\')' },
        { key: 'ean13', required: true, source: 'po', notes: '\'Barcode: Refer PO, to be generated as EAN13\'' },
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
        { key: 'oekoTexLogo', required: false, source: 'article', notes: '\'Add Oeko tex logo here If required\'' },
        { key: 'poNumber', required: true, source: 'po', notes: 'Rendered as \'PO No. C-PO…\'' },
      ],
    },
  ],
  dimensionsVerified: true,
  notes: 'Sewn wash care label: width 35 mm, finished length 90 mm (callout \'Width- 35mm, finished length- 90mm\'). Sheet 1 single-sided; sheets 2-3 printed front/back. Quality: \'White soft Stain, no burned edges\'.',
};

export default spec;
