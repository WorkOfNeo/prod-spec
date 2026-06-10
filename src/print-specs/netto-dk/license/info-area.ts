import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'netto-dk-license-info-area',
  customer: 'Netto DK',
  businessArea: 'License',
  printType: 'info-area',
  renderStrategy: 'dynamic',
  sourcePdf: 'Netto DK-License-Info Area.pdf',
  layoutFamily: 'info-area-netto-dk',
  parts: [
    {
      id: 'print-area',
      dimensions: { widthMm: 0, heightMm: 0 },
      fields: [
        { key: 'composition', languages: ['DA'], required: true, source: 'article', notes: 'Example \'100% Bomuld\'' },
        { key: 'washCareSymbols', required: true, source: 'article' },
        { key: 'ean13', required: true, source: 'po', notes: '\'BARCODE / EAN NUMBER HERE\' — EAN-13' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: '\'Direct print on packaging\' — size follows the packaging; no fixed dimensions (0×0 = size-changeable by design).',
};

export default spec;
