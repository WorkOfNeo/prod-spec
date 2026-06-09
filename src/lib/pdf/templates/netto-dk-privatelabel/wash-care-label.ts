import type { StyleData } from "../../types";
import type { OutputDims } from "../../template-registry";
import { renderCareLabel02Html } from "../care-label-02";

// netto-dk-privatelabel · Wash Care Label — 35 × 90 mm folded, multi-sheet.
//
// Structurally identical to the kept `care-label-02` (composition + wash-care
// symbols, multilingual care instructions, "Made in <country>", PO No., the
// CONTRAST COMPANY brand block, and certificates/QR on the back sheet), which
// is exactly what the Netto reference PDF specifies. Rather than fork ~400
// lines we delegate to that renderer so the two stay in lockstep.
//
// This thin wrapper exists as the seam for Netto-specific divergence: if the
// Netto spec later needs a different language set, brand block, or sheet
// layout, fork the body here without touching the generic care-label-02.
export async function renderNettoWashCareLabelHtml(
  style: StyleData,
  dims: OutputDims,
): Promise<string> {
  return renderCareLabel02Html(style, dims);
}
