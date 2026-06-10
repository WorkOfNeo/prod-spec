import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'tokmanni-private-label-carton-marking',
  customer: 'Tokmanni',
  businessArea: 'Private label',
  printType: 'carton-marking',
  renderStrategy: 'static-pdf',
  sourcePdf: 'Tokmanni-Private label-Carton Marking.pdf',
  layoutFamily: 'carton-marking-tokmanni',
  dimensions: { widthMm: 100, heightMm: 75 },
  dimensionsVerified: true,
  notes: 'Carton sticker 100×75 mm (callouts \'10 cm\' / \'7.5 cm\'), emitted as static PDF. TOKMANNI OY block per article: order no., product GTIN code (EAN-13 shown), qty in inner/export carton, batch no. (= Contrast PO), carton no., gross weight, carton measurement, product barcode.',
};

export default spec;
