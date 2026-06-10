import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'kaufland-license-carton-marking-layout',
  customer: 'Kaufland',
  businessArea: 'License',
  printType: 'carton-marking',
  renderStrategy: 'static-pdf',
  sourcePdf: 'Kaufland-License-Carton marking layout.pdf',
  layoutFamily: 'carton-marking-kaufland',
  dimensions: { widthMm: 200, heightMm: 75 },
  dimensionsVerified: true,
  notes: 'Carton sticker 200×75 mm (callout \'size 200 x 75 mm\'), emitted as static PDF. KAUFLAND INTERNATIONAL block: outer VE (sales unit), KL no., supplier no., lot, EAN code — barcode marker reads \'EAN 13\' (not EAN-128).',
};

export default spec;
