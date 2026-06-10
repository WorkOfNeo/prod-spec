import type { PrintSpec } from "@/print-specs/shared/types";
import type { StyleData } from "../../types";
import type { OutputDims } from "../../template-registry";
import { renderNettoCartonMarkingHtml } from "../netto-dk-privatelabel/carton-marking";

// Family renderer for `carton-marking-netto-dk` (Netto DK Body Guide /
// License / Private Label — one reference drawing, three member specs).
//
// The source PDFs are annotated layout DRAWINGS (red arrows, yellow FOB/DDP
// banners, internal comments), so the static-pdf passthrough used to ship
// the annotations to the supplier. These specs are dynamic instead: the
// clean box label is drawn by the shared Netto carton template. The spec is
// passed through so its declarative field bindings (e.g. the FOB/DDP
// order-number switch) drive the render; per-member divergence forks here.
export function makeNettoCartonMarkingRenderer(
  spec: PrintSpec,
): (style: StyleData, dims: OutputDims) => Promise<string> {
  return (style, dims) => renderNettoCartonMarkingHtml(style, dims, spec);
}
