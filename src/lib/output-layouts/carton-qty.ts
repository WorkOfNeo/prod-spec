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
//
// A SECOND, independent axis: some cells carry the inner/outer PACK PAIR —
// how many pieces go in the inner box vs the outer carton:
//
//   "Solid= 5/20"   "8/8"   "6/18"
//
// Bare {{qtyPerCarton}} takes the first number, which is the INNER count —
// so a carton marking that prints the bare token on its "Outer box" line is
// silently one box-level off. {{qtyPerCarton:inner}} / :outer name the level
// explicitly.
// =====================================================

export const CARTON_QTY_KINDS = ["solid", "assort", "inner", "outer"] as const;
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

// An inner/outer pack pair: two slash-separated numbers, optionally behind a
// label the buyer typed ("Solid= 5/20", "8/8", "6/18").
//
// Anchored to the WHOLE value on purpose. Cells that merely CONTAIN a slash or
// a "+" total are not pairs and must not be split:
//   "KH10058 A+ KH10058 C (5+5)=10"  → two sub-styles of 5, total 10
//   "Solid - 5 / Assort - 8"         → the solid/assort axis, not box levels
// Both fail the anchor, so they fall through to the existing rules.
const PACK_PAIR_RE =
  /^\s*(?:[A-Za-z]+\s*[=:-]\s*)?(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*$/;

// The inner-box or outer-carton count from a pack pair, or null when the value
// isn't a pair at all (one number serves both levels — the caller falls back).
export function pickCartonQtyPair(
  raw: string | undefined,
  kind: "inner" | "outer",
): string | null {
  const m = PACK_PAIR_RE.exec((raw ?? "").trim());
  if (!m) return null;
  return kind === "inner" ? m[1] : m[2];
}
