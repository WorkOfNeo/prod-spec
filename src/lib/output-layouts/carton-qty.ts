// =====================================================
// Carton-qty variant picker — CLIENT-SAFE (token-meta.ts validation and the
// builder palette import it, like schema.ts / calc.ts), no server deps.
//
// Some Pre-Order "Carton qty (outer VE)" cells carry TWO pack sizes: how
// many pieces fit a SOLID carton (one style) vs an ASSORT carton (mixed):
//
//   "Solid - 5 / Assort - 8"
//
// The whole string is preserved on StyleData.cartonQtyRaw (the numeric
// parse `carton.outerVE` is 0 for these). {{qtyPerCarton:solid}} /
// {{qtyPerCarton:assort}} narrow it to one number; bare {{qtyPerCarton}}
// keeps its current behaviour (the numeric parse, else the raw text).
// =====================================================

export const CARTON_QTY_KINDS = ["solid", "assort"] as const;
export type CartonQtyKind = (typeof CARTON_QTY_KINDS)[number];

// Does a raw carton-qty value carry a Solid/Assort split at all? A plain
// number ("48") or a per-size "SIZE=qty" list has none — that single value
// serves both variants, so the picker hands it back untouched.
const SPLIT_RE = /\b(?:solid|assort)\b/i;

// The number a Solid/Assort split assigns to one variant. Returns:
//   • the variant's number         → "Solid - 5 / Assort - 8" + "assort" → "8"
//   • the whole value untouched     → non-split value (plain number / size list)
//   • ""                            → a split that has the OTHER variant but
//                                     not this one (a real gap → amber chip)
export function pickCartonQtyVariant(raw: string | undefined, kind: string): string {
  const source = (raw ?? "").trim();
  if (!source) return "";
  if (!SPLIT_RE.test(source)) return source;
  // Match the variant label, skip the "- " / ": " / "= " separator (but never
  // a digit or the "/" that starts the next variant), then take its number.
  const m = new RegExp(`\\b${kind.toLowerCase()}\\b[^\\d/]*(\\d+(?:[.,]\\d+)?)`, "i").exec(source);
  return m ? m[1] : "";
}
