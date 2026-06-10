import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'europris-t2c-po62740-rev-carelabel-2026-4-21',
  customer: 'Europris',
  businessArea: 'T2C',
  printType: 'care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Europris-T2C-PO62740 REV carelabel 2026.4.21.PDF',
  layoutFamily: 'care-label-t2c',
  parts: [
    {
      id: 'label',
      dimensions: { widthMm: 35, heightMm: 66 },
      fields: [
        { key: 'sizes', required: true, source: 'po', notes: 'Example \'ONESIZE\'' },
        { key: 'customerItemNo', required: true, source: 'po', notes: 'Rendered \'Art No.: …\'' },
        { key: 'ean13', required: true, source: 'po', notes: 'Digits + bars, e.g. 7022812232816' },
        { key: 'composition', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL', 'FR', 'PL'], required: true, source: 'article', notes: 'Example \'70% Polyester 21% Polyamide 8% Wool 1% Elastane\' in 9 languages' },
        { key: 'careInstructions', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL', 'FR', 'PL'], required: true, source: 'article' },
        { key: 'washCareSymbols', required: true, source: 'article' },
        { key: 'countryOfOrigin', languages: ['EN', 'DA', 'DE', 'FI', 'NO', 'SV', 'NL', 'FR', 'PL'], required: true, source: 'po', notes: '\'Made in China / Fremstillet i Kina / …\'' },
        { key: 'poNumber', required: true, source: 'po', notes: 'Rendered \'PO No. C-PO…\'' },
        { key: 'supplierAddress', required: true, source: 'customer-master', notes: 'CONTRAST COMPANY block: Rudolfgårdsvej 6A - 8260 Viby J - DK / www.contrast.dk/info@contrast.dk' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'Scanned care label; size callout OCR-garbled (\'3.5X6.6cm\') → 35×66 mm best estimate — verify (brief F8). T2C logo in artwork.',
};

export default spec;
