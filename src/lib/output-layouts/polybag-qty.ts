// =====================================================
// Pieces per solid polybag, read off Monday's Trims column. Backs
// {{polybagQty}}.
//
// The buyer states the pack size as a trim entry rather than in a column of
// its own, so the number has to be lifted out of the entry's wording. Live
// shapes (Tokmanni, Dollarstore):
//
//   "Solid polybag- 5 Pcs / Polybag"      → 5
//   "Solid Polybag - 2 Pcs/ Polybag"      → 2
//   "1 pc individual polybag for solid"   → "" (one piece: no qty field)
//   "10 pcs/master polybag"               → ignored (a MASTER polybag)
//
// The sticker rule the buyer gave: print a quantity field only when more than
// one piece is packed. So the token resolves ONLY a count above one, and
// everything else — one piece, no count, no polybag entry, no Trims at all —
// is "". That makes the field one conditional on the layout:
//
//   {{if polybagQty != ""}}QTY: {{polybagQty}} PCS{{endif}}
//
// Master and assortment polybags are skipped: their count is how many solid
// packs go in the outer bag, not what the solid polybag sticker states.
// =====================================================

import { splitTrimsCell } from "@/lib/trims/classify";

const POLYBAG = /poly\s*bag/i;
const NOT_SOLID = /master|assort/i;
const PIECE_COUNT = /(\d+)\s*(?:pcs?|pieces?)\b/i;

export function resolvePolybagQty(trimsRaw: string | undefined | null): string {
  for (const entry of splitTrimsCell(trimsRaw ?? "")) {
    if (!POLYBAG.test(entry) || NOT_SOLID.test(entry)) continue;
    const m = PIECE_COUNT.exec(entry);
    if (!m) continue;
    const qty = Number(m[1]);
    return qty > 1 ? String(qty) : "";
  }
  return "";
}
