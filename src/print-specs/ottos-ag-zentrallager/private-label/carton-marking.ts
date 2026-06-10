import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'ottos-ag-zentrallager-private-label-carton-marking',
  customer: 'Otto\'s AG Zentrallager',
  businessArea: 'Private label',
  printType: 'carton-marking',
  renderStrategy: 'static-pdf',
  sourcePdf: 'Otto\'s AG Zentrallager-Private label-Carton marking.pdf',
  layoutFamily: 'carton-marking-ottos',
  dimensionsVerified: false,
  notes: 'Carton marking emitted as static PDF. Scanned/sparse layout; only extractable marker: \'Customer Order Number\'. Print size per PO — no fixed dimensions.',
};

export default spec;
