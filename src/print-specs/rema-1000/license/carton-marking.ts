import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'rema-1000-license-carton-marking',
  customer: 'Rema 1000',
  businessArea: 'License',
  printType: 'carton-marking',
  renderStrategy: 'static-pdf',
  sourcePdf: 'Rema 1000-License-Carton marking.pdf',
  layoutFamily: 'carton-marking-rema',
  dimensionsVerified: false,
  notes: 'Box marking emitted as static PDF. Print size per PO — no fixed dimensions. REMA layout: order no., \'VARE NR.\', \'EAN-NR.\' (\'EAN NUMBER HERE\'), pcs per colli, weight per carton, carton no./of. Placement: centre of box, at least 30 mm from any edge. Carton barcode type not explicit in layout — EAN-128 per brief rule for carton markings.',
};

export default spec;
