import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'ge-kas-ullared-license-carton-marking-layout',
  customer: 'Ge-kås Ullared',
  businessArea: 'License',
  printType: 'carton-marking',
  renderStrategy: 'static-pdf',
  sourcePdf: 'Ge-kås Ullared-License-Carton marking layout.pdf',
  layoutFamily: 'carton-marking-ge-kas',
  dimensionsVerified: false,
  notes: 'Carton marking emitted as static PDF. Print size per PO — no fixed dimensions. Per-size carton blocks (example 128-170): article number \'B/…\', description + size range, colour, customer order number, carton number, supplier (Contrast Company A/S), pcs/carton, Contrast order no., EAN-13.',
};

export default spec;
