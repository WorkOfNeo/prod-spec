import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'sok-private-label-washcare-label',
  customer: 'SOK',
  businessArea: 'Private Label',
  printType: 'wash-care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'SOK-Private Label-Washcare label.pdf',
  layoutFamily: 'wash-care-scanned-10lang',
  parts: [
    {
      id: 'sheet1',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'sizes', required: true, source: 'po', notes: 'Header \'Size / Stl / Str\'; example shows 4 size breaks (S-XL), one sheet-1 block per size' },
        { key: 'ean13', required: true, source: 'po', notes: 'Barcode not legible in scan; EAN-13 assumed per F1-family structure — confirm' },
      ],
    },
    {
      id: 'sheet2-front',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'composition', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL', 'FR', 'PL', 'ET'], required: true, source: 'article', notes: '10 languages incl. Estonian, e.g. \'EST: 100% Puuvill\'' },
        { key: 'washCareSymbols', required: true, source: 'article', notes: 'Not legible in scan — assumed per F1-family structure' },
      ],
    },
    {
      id: 'sheet2-back',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'careInstructions', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL'], required: true, source: 'article', notes: 'Continues on sheet 3 (front) with FR, PL and ET' },
      ],
    },
    {
      id: 'sheet3-front',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'careInstructions', languages: ['FR', 'PL', 'ET'], required: true, source: 'article', notes: 'Continuation from sheet 2 (back); Estonian block \'EST: Pesta koos sarnaste värvidega / Pesta enne kandmist / Pesta ja triikida pahupidi\'' },
        { key: 'countryOfOrigin', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL', 'FR', 'PL', 'ET'], required: true, source: 'po', notes: 'Single combined block, e.g. \'Made in India / … / Tootjariik Indie\'' },
      ],
    },
    {
      id: 'sheet3-back',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'poNumber', required: true, source: 'po' },
        { key: 'supplierAddress', required: true, source: 'customer-master', notes: 'CONTRAST block: Rudolfgårdsvej 6A - 8260 Viby J - DK / info@contrast.dk / www.contrast.dk' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'Scanned A4 document — no mm callouts. Sheet structure mirrors the F1 35×90 family (sheet 1 single-sided, sheets 2-3 front/back); 35×90 mm are PLACEHOLDER dimensions from that family — measure physical samples before production (brief F5).',
};

export default spec;
