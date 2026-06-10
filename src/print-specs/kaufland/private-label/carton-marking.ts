import type { PrintSpec } from '../../shared/types';

export const spec: PrintSpec = {
  id: 'kaufland-private-label-carton-marking',
  customer: 'Kaufland',
  businessArea: 'Private Label',
  printType: 'carton-marking',
  renderStrategy: 'static-pdf',
  sourcePdf: 'Kaufland-Private Label-Carton marking.pdf',
  layoutFamily: 'carton-marking-kaufland',
  dimensionsVerified: false,
  notes: 'Field-marker template (markers: Description, Sales unit, KL No., Lot No, EAN Code), emitted as static PDF. No size callout — the License sibling is 200×75 mm; verify before production.',
};

export default spec;
