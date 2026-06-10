import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'netto-de-body-guide-carton-sticker-bodyguide-license-1',
  customer: 'Netto DE',
  businessArea: 'Body Guide',
  printType: 'carton-marking',
  renderStrategy: 'static-pdf',
  sourcePdf: 'Netto DE-Body Guide-Carton sticker - Bodyguide & License 1.pdf',
  layoutFamily: 'carton-sticker-netto-de',
  dimensionsVerified: true,
  notes: 'Carton sticker emitted as static PDF. Two formats in one document: 240×180 mm (\'Width- 240mm, length- 180mm\') and 150×110 mm (\'Width- 150mm, length- 110mm\') — not representable as a single dimensions value, so none is set. Table layout per colourway: order, art-no, description, size, quantity; plus customer order number, style number, colour, carton no., totals.',
};

export default spec;
