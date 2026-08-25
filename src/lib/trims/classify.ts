// =====================================================
// Classifying a piece of packaging vocabulary onto a trim concept.
//
// The SAME rules run over both sides of the problem:
//   • Monday "Trims" entries — buyer/supplier vocabulary, 171 distinct values
//     live, free-ish text with case, spacing and spelling drift.
//   • Output Builder layout names — "<Customer> - <Business area> - <Document>",
//     of which only the trailing <Document> segment carries the meaning.
// Measured on the live estate, these rules classify 124/171 trim labels and
// 132/138 layouts, which is what makes the mapping a one-off vocabulary job
// rather than per-customer wiring.
//
// ORDER IS LOAD-BEARING, NOT COSMETIC. The rules are evaluated in order and the
// FIRST hit wins. The case that forces this: "Carton marking- Color sticker" is
// on 1,139 live styles and it is a COLOUR STICKER, not a carton marking. A
// plain "contains" over an unordered rule set calls it a carton marking every
// time. So the colour-sticker rule sits above the carton-marking rule, and any
// new rule must be inserted where its specificity belongs.
//
// AMBIGUITY IS REPORTED, NEVER GUESSED AWAY. When more than one rule matches a
// single part, the first still wins (so classification is total and the cover
// always prints something) but `ambiguous` is set, so the settings screen can
// surface exactly which labels a human should confirm. A stored override then
// settles it permanently.
//
// COMPOUND LABELS ARE REAL. "Hanger & Hangtag" (220 styles), "Hangtag +
// Banderole" (87) and "Polybag + Inlaycard + Hangtag" (12) each name several
// items in one dropdown value, so a label resolves to a SET of concepts, not
// one. Splitting happens before matching, or "Hanger & Hangtag" would classify
// as a hanger and quietly lose the hangtag.
//
// CLIENT-SAFE: pure, no db, no server imports. Unit-tested in classify.test.ts.
// =====================================================

export type TrimRule = {
  concept: string;
  // Any keyword matching (as a normalised substring) → the rule matches.
  // A list because the vocabulary is messy: "belly band" and "Bellyband" are
  // the same item and only differ by a space.
  keywords: string[];
};

// Seed rule set, ordered most-specific-first. Derived from a census of all 171
// live trim labels plus the 138-layout catalogue. Editable at
// /settings/trims — this is the fallback when nothing is stored yet.
export const DEFAULT_TRIM_RULES: TrimRule[] = [
  // Above CARTON_MARKING on purpose: "Carton marking- Color sticker" (1,139
  // styles) is a colour sticker. Reordering these two silently mislabels it.
  { concept: "COLOUR_STICKER", keywords: ["color sticker", "colour sticker", "color card", "colour card", "colored size tag"] },
  { concept: "CARTON_MARKING", keywords: ["carton marking", "carton mark", "shipping mark", "carton label", "printed on carton"] },
  { concept: "CARE_LABEL", keywords: ["wash care", "washcare", "care label", "oeko", "oekotex"] },
  { concept: "NECK_PRINT", keywords: ["neck print", "neckprint"] },
  { concept: "BANDEROLE", keywords: ["banderole", "bellyband", "belly band"] },
  { concept: "HANGTAG", keywords: ["hangtag", "hang tag", "socktag", "sock tag", "bci tag", "glove tag", "part of set tag", "tab label"] },
  { concept: "HANGER", keywords: ["hanger", "hangs"] },
  { concept: "POLYBAG_STICKER", keywords: ["polybag sticker", "polybag w. sticker", "polybag w.sticker", "bag sticker"] },
  { concept: "POLYBAG", keywords: ["polybag", "pouch", "flat packed"] },
  { concept: "PRICE_STICKER", keywords: ["price sticker", "price tag", "pricing tag"] },
  { concept: "BARCODE_STICKER", keywords: ["barcode", "ean sticker", "style ean", "assortment sticker", "assort pack"] },
  { concept: "MAIN_LABEL", keywords: ["main label", "mainlabel", "woven label", "soft label", "product information label"] },
  { concept: "SIZE_LABEL", keywords: ["size label", "size tag"] },
  { concept: "INFO_AREA", keywords: ["info area", "info sticker", "inlay card", "inlaycard", "insert card", "inner pack sticker"] },
  { concept: "TOPCARD", keywords: ["topcard", "top card", "headercard", "header card", "supportive card"] },
  { concept: "PICTOGRAM", keywords: ["pictogram"] },
  { concept: "HEAT_TRANSFER", keywords: ["heat transfer"] },
  { concept: "RFID", keywords: ["rfid", "alarm label", "security label"] },
  { concept: "BOX", keywords: ["carton box", "giftbox", "gift box", "display box", "display", "box"] },
  { concept: "HOOK", keywords: ["hook", "ribbon", "string", "loop"] },
  { concept: "PACKING_NOTE", keywords: ["silica gel", "super dry", "see customer order", "top folded", "distributor"] },
];

// Fold case, punctuation and repeated whitespace so "carton Marking" (1,508
// styles) and "Carton Marking" (473) are the same key. Deliberately does NOT
// fold missing spaces — "Bellyband" vs "Belly Band" stays a keyword problem,
// solved by listing both, because collapsing spaces entirely would make
// unrelated words collide.
export function normalizeTrimLabel(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Split a dropdown value that names several items. Separators seen live:
// "&", "+", and the word "and".
export function splitCompoundLabel(label: string): string[] {
  return label
    .split(/\s*[&+]\s*|\s+and\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

export type TrimClassification = {
  // Concepts this label resolves to, in first-match order. Empty ⇒ no rule hit;
  // the label is unknown vocabulary and needs a human (or a new keyword).
  concepts: string[];
  // At least one part matched more than one rule. The first still won, but the
  // settings screen flags it for confirmation.
  ambiguous: boolean;
};

// Classify one piece of vocabulary. `rules` is the stored/edited set; pass
// DEFAULT_TRIM_RULES when nothing is configured.
export function classifyTrimLabel(
  label: string,
  rules: ReadonlyArray<TrimRule> = DEFAULT_TRIM_RULES,
): TrimClassification {
  const concepts: string[] = [];
  let ambiguous = false;

  for (const part of splitCompoundLabel(label)) {
    const n = normalizeTrimLabel(part);
    if (!n) continue;
    const hits: string[] = [];
    for (const rule of rules) {
      if (rule.keywords.some((k) => k.trim() !== "" && n.includes(normalizeTrimLabel(k)))) {
        hits.push(rule.concept);
      }
    }
    // Distinct concepts only: two keywords of the SAME rule matching is not
    // ambiguity, it's just a well-covered rule.
    const distinct = [...new Set(hits)];
    if (distinct.length > 1) ambiguous = true;
    if (distinct[0] && !concepts.includes(distinct[0])) concepts.push(distinct[0]);
  }

  return { concepts, ambiguous };
}

// The meaning-bearing tail of a layout name. "Coop DK - Private Label - Care
// Label" → "Care Label". A name without the separator is used whole, so a
// free-form layout name still gets a chance to classify.
export function layoutDocumentSegment(name: string): string {
  const parts = name.split(" - ").map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : name.trim();
}

// Classify a layout by its name. Single concept (a layout produces one kind of
// document), so the first hit wins outright — the compound splitting that trim
// labels need would be wrong here: "Carton Marking (Front + Side Label)" is one
// document, not two.
export function classifyLayoutName(
  name: string,
  rules: ReadonlyArray<TrimRule> = DEFAULT_TRIM_RULES,
): string | null {
  const n = normalizeTrimLabel(layoutDocumentSegment(name));
  if (!n) return null;
  for (const rule of rules) {
    if (rule.keywords.some((k) => k.trim() !== "" && n.includes(normalizeTrimLabel(k)))) {
      return rule.concept;
    }
  }
  return null;
}

// Split a Monday Trims cell into its individual labels. Dropdown values are
// comma-separated; newlines and semicolons appear in hand-typed cells.
export function splitTrimsCell(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[,;\n]+/)) {
    const v = part.trim();
    if (!v) continue;
    // De-dupe on the normalised key so one style can't list "Hangtag" and
    // "hangtag" as two separate rows, but keep the FIRST spelling for print —
    // the cover quotes Monday verbatim so the supplier can tick it off.
    const key = normalizeTrimLabel(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
