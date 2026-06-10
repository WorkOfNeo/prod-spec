import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'kaufland-license-washcare-label-layout',
  customer: 'Kaufland',
  businessArea: 'License',
  printType: 'wash-care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Kaufland-License-Washcare label layout.pdf',
  layoutFamily: 'wash-care-kaufland-cee',
  parts: [
    {
      id: 'label',
      dimensions: { widthMm: 155, heightMm: 40 },
      fields: [
        { key: 'composition', languages: ['DE', 'CS', 'HR', 'RO', 'SK', 'BG'], required: true, source: 'article', notes: 'Combined block, e.g. \'93% Baumwolle / Bavlna / Pamuk / Bumbac / Bavlna / Памук\'' },
        { key: 'careInstructions', languages: ['DE', 'CS', 'HR', 'RO', 'SK', 'BG'], required: true, source: 'article', notes: 'Single combined slash-separated block in all 6 languages' },
        { key: 'washCareSymbols', required: true, source: 'article', notes: '\'40°\' symbols row' },
        { key: 'ean13', required: true, source: 'po', notes: 'EAN-13; one label strip per size with size-specific EAN' },
        { key: 'countryOfOrigin', languages: ['DE', 'CS', 'HR', 'RO', 'SK', 'BG'], required: true, source: 'po', notes: '\'Herkunftsland : Indien / Země původu / Zemlja podrijetla / Locul de origine / Krajina pôvodu / Страна на произход\'' },
        { key: 'supplierAddress', required: true, source: 'customer-master', notes: 'Manufacturer block \'Hersteller / Výrobce / Proizvođač / Producător / Výrobca / Производител\' + \'Contrast Company A/S, Rudolfgårdsvej 6A, DK-8260 Viby J / info@contrast.dk/www.contrast.dk\'' },
        { key: 'poNumber', required: true, source: 'po', notes: 'Rendered \'PO no.: C-PO…\'' },
      ],
    },
  ],
  dimensionsVerified: true,
  notes: 'Wide single-strip wash care label 155×40 mm (callouts \'155.00 mm\' / \'40.00 mm\'); one strip per size, each with its own EAN-13. Production year (example \'2026\') printed at the foot of each strip — not modelled as a field. Example shows two styles with 3 sizes each.',
};

export default spec;
