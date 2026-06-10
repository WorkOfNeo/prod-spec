import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'runsven-license-po63084-evc00130-carelabel',
  customer: 'Runsven',
  businessArea: 'License',
  printType: 'care-label',
  renderStrategy: 'dynamic',
  sourcePdf: 'Runsven-License-PO63084  EVC00130 carelabel.pdf',
  layoutFamily: 'care-label-runsven-evc',
  parts: [
    {
      id: 'label',
      dimensions: { widthMm: 35, heightMm: 90 },
      fields: [
        { key: 'composition', languages: ['EN'], required: true, source: 'article', notes: 'Languages not extractable (image-only PDF); EN assumed from the Runsven License translation mapping — confirm' },
        { key: 'careInstructions', languages: ['EN'], required: true, source: 'article', notes: 'Languages not extractable (image-only PDF); EN assumed — confirm' },
        { key: 'sizes', required: false, source: 'po', notes: 'Presence unconfirmed — image-only PDF' },
        { key: 'ean13', required: false, source: 'po', notes: 'Presence unconfirmed — image-only PDF' },
      ],
    },
  ],
  dimensionsVerified: false,
  notes: 'manual review required — image-only PDF with zero extractable text (brief special flag). Field set and 35×90 mm PLACEHOLDER dimensions assumed from Runsven care-label conventions; verify against a physical sample before production.',
};

export default spec;
