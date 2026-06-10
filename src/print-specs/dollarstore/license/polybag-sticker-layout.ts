import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'dollarstore-license-polybag-sticker-layout',
  customer: 'Dollarstore',
  businessArea: 'License',
  printType: 'polybag-sticker',
  renderStrategy: 'dynamic',
  sourcePdf: 'Dollarstore-License-Polybag sticker layout.pdf',
  layoutFamily: 'polybag-dollarstore',
  parts: [
    {
      id: 'sticker',
      dimensions: { widthMm: 105, heightMm: 75 },
      fields: [
        { key: 'customerItemNo', required: true, source: 'po', notes: 'Header code + rendered \'Art. …\', e.g. \'PTQ10039\'' },
        { key: 'description', languages: ['EN'], required: true, source: 'po', notes: 'Example \'T-Shirt Paw Patrol- Blue 98/104-122/128\' — includes colour and size span' },
        { key: 'qtyPerCarton', required: true, source: 'po', notes: 'Rendered \'Inner box: 8 pair\' — inner-box quantity' },
        { key: 'ean13', required: true, source: 'po', notes: 'Marker \'EAN Code\'' },
      ],
    },
  ],
  dimensionsVerified: true,
  notes: 'Assortment polybag sticker 105×75 mm (callouts \'105 mm\' / \'75 mm\'); six example articles across two pages.',
};

export default spec;
