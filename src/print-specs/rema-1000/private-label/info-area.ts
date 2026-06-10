import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'rema-1000-private-label-info-area',
  customer: 'Rema 1000',
  businessArea: 'Private Label',
  printType: 'info-area',
  renderStrategy: 'dynamic',
  sourcePdf: 'Rema 1000-Private Label-Info Area.pdf',
  layoutFamily: 'info-area-rema',
  parts: [
    {
      id: 'print-area',
      dimensions: { widthMm: 0, heightMm: 0 },
      fields: [
        { key: 'retailPrice', required: true, source: 'po', notes: 'Example \'Pris Kr. 29,00\' (NOK)' },
        { key: 'ean13', required: true, source: 'po', notes: '\'BARCODE / EAN NUMBER HERE\' — EAN-13' },
        { key: 'batchNo', required: true, source: 'po', notes: 'Rendered \'Batch no.\'; layout marker \'Customer Order Number\' points at this line' },
        { key: 'articleNo', required: true, source: 'po', notes: 'Rendered \'Article no.\'; layout marker \'Customer Item No\' points at this line' },
        { key: 'composition', languages: ['EN', 'NO'], required: true, source: 'article', notes: 'Example \'100% Polyester\' is language-neutral; EN/NO per translation mapping' },
        { key: 'washCareSymbols', required: true, source: 'article' },
      ],
    },
  ],
  dimensionsVerified: false,
  currency: 'NOK',
  notes: 'Direct print on packaging — size follows the packaging; no fixed dimensions (0×0 = size-changeable by design).',
};

export default spec;
