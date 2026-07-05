// Colour-letter scoping of PO variants. Pure + free of server deps so it's
// unit-testable (like size-match.ts). Used by resolve-style-eans.
//
// Some customers (e.g. Netto) order TWO Pre-Order rows against ONE PO section
// that lists both colourways ("A-M Colour A black/white …" + "B-M Colour B
// navy/white …"). Each row's 🎨 Colour code column then carries a "*A" / "*B"
// marker naming which colourway is THAT style's. Without scoping, both styles
// scrape all colourways' EANs and every size shows up twice with two different
// barcodes.

/**
 * The PO colour letters a style's Colour code column claims, e.g. "*A" → ["A"].
 *
 * The column is a Monday dropdown whose text joins the selected labels with
 * ", ". Only a single-letter label STARRED like "*A" activates scoping — the
 * column mostly carries plain colour names ("*Pink", "A-Black", "Navy") that
 * say nothing about PO colourway letters. Once any starred letter is present,
 * bare single-letter labels in the same value count too ("*A, B" → A + B, a
 * style that owns both colourways).
 */
export function colourLettersFromCode(colourCode: string): string[] {
  const tokens = colourCode
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const starred = tokens
    .map((t) => t.match(/^\*([A-Za-z])$/)?.[1])
    .filter((l): l is string => Boolean(l));
  if (starred.length === 0) return [];
  const bare = tokens
    .map((t) => t.match(/^([A-Za-z])$/)?.[1])
    .filter((l): l is string => Boolean(l));
  return [...new Set([...starred, ...bare].map((l) => l.toUpperCase()))];
}

/**
 * The colourway letter a PO variant row is marked with, or null when the row
 * carries no letter marker.
 *
 * Two signals, matching how Contrast POs print letter-marked rows
 * ("A-M Colour A black/white, M"):
 *   1. the "Colour <letter>" token in the description — a SINGLE letter, so
 *      "Colour navy" doesn't match;
 *   2. the single-letter "<X>-" variant prefix — two-letter colour
 *      abbreviations ("PI-86/92", "NA-", ".B-") deliberately don't match.
 */
export function variantColourLetter(label: string): string | null {
  const token = label.match(/\bcolou?r\s+([A-Za-z])(?![A-Za-z0-9])/i)?.[1];
  if (token) return token.toUpperCase();
  const prefix = label.match(/^([A-Za-z])-/)?.[1];
  return prefix ? prefix.toUpperCase() : null;
}

/** Does this variant row belong to one of the style's colour letters? */
export function variantMatchesColour(label: string, letters: string[]): boolean {
  const l = variantColourLetter(label);
  return l !== null && letters.includes(l);
}

export type ColourScope<T> = {
  /** The variants that belong to this style (all of them when not applied). */
  variants: T[];
  /** True when the style has "*X" letters AND the PO rows are letter-marked. */
  applied: boolean;
  /** Letters parsed off the style's Colour code ("*A" → ["A"]). */
  letters: string[];
  /** Variants dropped as other colourways' rows (0 when not applied). */
  excluded: number;
};

/**
 * Keep only the variants of the style's own colourway(s).
 *
 * Scoping applies only when BOTH sides speak the letter convention: the
 * style's Colour code carries "*X" letters and at least one PO row is
 * letter-marked. A "*A" style against a PO without letter-marked rows (single
 * colourway, or colour-name rows like "Pink, 86/92") keeps every variant —
 * exactly the pre-scoping behaviour. When the PO IS letter-marked but none of
 * the rows matches the style's letters, the scope comes back empty on purpose:
 * grabbing another colourway's EANs is the exact bug this prevents, so the
 * caller surfaces it (no_eans) instead of guessing.
 */
export function scopeVariantsByColour<T extends { label: string }>(
  variants: T[],
  colourCode: string,
): ColourScope<T> {
  const letters = colourLettersFromCode(colourCode);
  if (letters.length === 0) return { variants, applied: false, letters, excluded: 0 };
  const anyLettered = variants.some((v) => variantColourLetter(v.label) !== null);
  if (!anyLettered) return { variants, applied: false, letters, excluded: 0 };
  const scoped = variants.filter((v) => variantMatchesColour(v.label, letters));
  return { variants: scoped, applied: true, letters, excluded: variants.length - scoped.length };
}
