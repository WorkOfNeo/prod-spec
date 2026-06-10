import type { StyleData } from "../../types";
import type { OutputDims } from "../../template-registry";
import { renderNettoCartonMarkingHtml } from "../netto-dk-privatelabel/carton-marking";

// Family renderer for `carton-marking-netto-dk` (Netto DK Body Guide /
// License / Private Label — one reference drawing, three member specs).
//
// The source PDFs are annotated layout DRAWINGS (red arrows, yellow FOB/DDP
// banners, internal comments), so the static-pdf passthrough used to ship
// the annotations to the supplier. These specs are dynamic instead: the
// clean box label is drawn by the shared Netto carton template. All three
// members render identically today (no per-spec parameter needed yet);
// per-member divergence would fork here.
export function makeNettoCartonMarkingRenderer(): (
  style: StyleData,
  dims: OutputDims,
) => Promise<string> {
  return (style, dims) => renderNettoCartonMarkingHtml(style, dims);
}
