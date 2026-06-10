import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'europris-t2c-62916-carton-marking-layout',
  customer: 'Europris',
  businessArea: 'T2C',
  printType: 'carton-marking',
  renderStrategy: 'static-pdf',
  sourcePdf: 'Europris-T2C-62916 - carton marking layout.pdf',
  layoutFamily: 'carton-marking-europris',
  dimensionsVerified: false,
  notes: 'Carton sticker emitted as static PDF. Print size per PO (\'BOX SIZE: W: L: H:\' left blank in layout) — no fixed dimensions. Fields in layout: order no., article no., description, size, colour, quantity, EAN no. (EAN-13 shown in example), gross/net weight, box size, ctn no., Contrast PO no.',
};

export default spec;
