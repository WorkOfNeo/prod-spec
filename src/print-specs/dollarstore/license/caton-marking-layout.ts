import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'dollarstore-license-caton-marking-layout',
  customer: 'Dollarstore',
  businessArea: 'License',
  printType: 'carton-marking',
  renderStrategy: 'static-pdf',
  sourcePdf: 'Dollarstore-License-Caton marking layout.pdf',
  layoutFamily: 'carton-marking-dollarstore',
  dimensionsVerified: true,
  notes: 'Carton marking emitted as static PDF. Two formats in one document: long side 200×60 mm and short side 150×75 mm (callouts; 40×20 mm barcode zones) — not representable as a single dimensions value, so none is set. Six-page document, one long/short pair per article: art no., description, inner/outer box qty, weights, measurement, Contrast order no., EAN barcode zone.',
};

export default spec;
