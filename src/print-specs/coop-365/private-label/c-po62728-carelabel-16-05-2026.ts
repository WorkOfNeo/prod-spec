import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'coop-365-private-label-c-po62728-carelabel-16-05-2026',
  customer: 'Coop 365',
  businessArea: 'Private Label',
  printType: 'care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Coop 365-Private Label-C-PO62728 Carelabel 16.05.2026.pdf',
  layoutFamily: 'care-label-coop-da-only',
  parts: [
    {
      id: 'fold-top',
      dimensions: { widthMm: 25, heightMm: 10 },
      fields: [
        { key: 'ean13', required: true, source: 'po', notes: 'Digits + bars, e.g. \'5706323581985\'' },
        { key: 'sizes', required: true, source: 'po', notes: 'Rendered \'Str\'; examples \'S/M\', \'L/XL\'' },
      ],
    },
    {
      id: 'panel-front',
      dimensions: { widthMm: 25, heightMm: 50 },
      fields: [
        { key: 'countryOfOrigin', languages: ['DA'], required: true, source: 'po', notes: 'Customer block: \'Produceret i Kina for Coop Danmark A/S / 2620 Albertslund / www.coop.dk\'' },
      ],
    },
    {
      id: 'panel-back',
      dimensions: { widthMm: 25, heightMm: 50 },
      fields: [
        { key: 'composition', languages: ['DA'], required: true, source: 'article', notes: 'Example \'Yderstof: 100% læder / For: 100% polyester\'' },
        { key: 'careInstructions', languages: ['DA'], required: true, source: 'article', notes: '\'Vaskes med lignende farver / vaskes inden brug / vaskes og stryges med vrangen ud\'' },
        { key: 'washCareSymbols', required: true, source: 'article' },
        { key: 'countryOfOrigin', languages: ['DA'], required: true, source: 'po', notes: '\'Fremstillet i Kina\'' },
        { key: 'poNumber', required: true, source: 'po', notes: 'Rendered \'PO No. C-PO…\'' },
        { key: 'supplierAddress', required: true, source: 'customer-master', notes: 'CONTRAST block: Rudolfgårdsvej 6A - 8260 Viby J - DK / www.contrast.dk/info@contrast.dk' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'Folded care label — callouts 25 mm (width), 10 mm (header strip) and 50 mm (each panel), marked \'To be folded\'. Scanned/OCR source; verify fold layout manually before production (brief F4).',
};

export default spec;
