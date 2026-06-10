import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'runsven-private-label-62951-carton-marking-layout',
  customer: 'Runsven',
  businessArea: 'Private Label',
  printType: 'carton-marking',
  renderStrategy: 'static-pdf',
  sourcePdf: 'Runsven-Private Label-62951 - carton marking layout.pdf',
  layoutFamily: 'carton-sticker-runsven',
  dimensions: { widthMm: 75, heightMm: 200 },
  dimensionsVerified: true,
  notes: 'Carton sticker 75×200 mm (callout \'SIZE : 75 X 200 mm\'), emitted as static PDF. Fields: order no. (+ C-PO), description, article no., qty, G.W./N.W., meas, supplier (Contrast Company A/S), C/no. Markers: Customer Order Number, PO Number, Description, Customer Item No, Qty/Carton.',
};

export default spec;
