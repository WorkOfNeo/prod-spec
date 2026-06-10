import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'coop-dk-loved-62522-care-label-layout',
  customer: 'Coop DK',
  businessArea: 'Loved',
  printType: 'care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Coop DK-Loved-62522 - care label layout.pdf',
  layoutFamily: 'care-label-coop-da-only',
  parts: [
    {
      id: 'label',
      dimensions: { widthMm: 25, heightMm: 95 },
      fields: [
        { key: 'sizes', required: true, source: 'po', notes: 'Example \'S/M\'' },
        { key: 'composition', languages: ['DA'], required: true, source: 'article', notes: 'Example \'95% Viskose / 5% Elasthan\'' },
        { key: 'washCareSymbols', required: true, source: 'article', notes: '\'30°\' + symbols row' },
        { key: 'careInstructions', languages: ['DA'], required: true, source: 'article', notes: '\'Vaskes før brug / Vaskes med lignende farver og vrangen udad / Stryges på vrangen\'' },
        { key: 'ean13', required: true, source: 'po', notes: 'Digits printed, e.g. 5706323574277' },
        { key: 'countryOfOrigin', languages: ['DA'], required: true, source: 'po', notes: '\'Fremstillet i Indien for Coop\'' },
        { key: 'poNumber', required: true, source: 'po', notes: 'Rendered \'PO no: C-PO…\'' },
        { key: 'supplierAddress', required: true, source: 'customer-master', notes: 'Contrast block: \'Rudolfgårdsvej 6A-8260 Viby J / info@contrast.dk/www.contrast.dk\'' },
      ],
    },
  ],
  dimensionsVerified: true,
  notes: 'Single-panel Danish-only care label, 25×95 mm (callouts \'25.00 mm\' / \'95 mm\').',
};

export default spec;
