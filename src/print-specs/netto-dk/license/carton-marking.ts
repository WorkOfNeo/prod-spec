import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'netto-dk-license-carton-marking',
  customer: 'Netto DK',
  businessArea: 'License',
  printType: 'carton-marking',
  renderStrategy: 'static-pdf',
  sourcePdf: 'Netto DK-License-Carton marking.pdf',
  layoutFamily: 'carton-marking-netto-dk',
  dimensionsVerified: false,
  notes: 'Carton/box marking emitted as static PDF. Print size per PO — no fixed dimensions. Layout carries field markers: customer order number (FOB orders) / Contrast order number (DDP orders), EAN-128 barcode (\'EAN BARCODE (see PO) — has to be generated as EAN128\'), EAN number, qty/carton, PO number, article/description, weight. Placement: centre of box, at least 30 mm from any edge.',
};

export default spec;
