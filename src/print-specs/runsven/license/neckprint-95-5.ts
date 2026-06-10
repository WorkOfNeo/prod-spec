import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'runsven-license-neckprint-95-5',
  customer: 'Runsven',
  businessArea: 'License',
  printType: 'neckprint',
  renderStrategy: 'dynamic',
  sourcePdf: 'Runsven-License-neckprint 95.5.pdf',
  layoutFamily: 'neckprint-runsven',
  parts: [
    {
      id: 'print',
      dimensions: { widthMm: 40, heightMm: 21 },
      fields: [
        { key: 'sizes', required: true, source: 'po' },
        { key: 'composition', languages: ['EN'], required: true, source: 'article', notes: 'Field marker only; language assumed EN — confirm' },
        { key: 'countryOfOrigin', languages: ['EN'], required: true, source: 'po', notes: 'Field marker only; language assumed EN — confirm' },
        { key: 'washCareSymbols', required: true, source: 'article' },
      ],
    },
  ],
  dimensionsVerified: true,
  notes: 'Neckprint 40×21 mm (callouts \'4.0 cm\' / \'2.1 cm\') inside a 55.3×43 mm placement area (\'5.53 cm\' / \'4.3 cm\'); colour WHITE. Print method transfer/screen — confirm (brief F12).',
};

export default spec;
