import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'netto-de-private-label-info-areas-1',
  customer: 'Netto DE',
  businessArea: 'Private label',
  printType: 'info-area',
  renderStrategy: 'dynamic',
  sourcePdf: 'Netto DE-Private label-INFO AREAS 1.pdf',
  layoutFamily: 'info-area-netto-de',
  parts: [
    {
      id: 'print-area',
      dimensions: { widthMm: 0, heightMm: 0 },
      fields: [
        { key: 'sizes', required: true, source: 'po', notes: 'Grid per size (62/68, 74/80, 86/92) and per colourway (example IL36460A/B)' },
        { key: 'composition', languages: ['DE'], required: true, source: 'article', notes: 'Example \'100% Baumwolle\'' },
        { key: 'washCareSymbols', required: true, source: 'article' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: '\'SIZE CHANGEABLE\' (explicit in layout) — info area scales per size/packaging; no fixed dimensions (0×0). Two pages: blank template + filled example.',
};

export default spec;
