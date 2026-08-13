import type { LayoutDef } from "./schema";
import { compositionLangsInDef, langArgsInDef, type TranslatedFieldLangs } from "./tokens";

// =====================================================
// Which per-language values a set of layouts actually prints.
//
// The renderer resolves {{composition:et}} / {{madeIn:fi}} / … through the
// translation bank, and it does that INSIDE renderLayoutHtml — see
// augmentCompositionTranslations / augmentTranslatedFields in ./render.ts.
// Every SYNC consumer of the same StyleData (the review page's catch-all line
// editor, the field editor's pre-fills) resolves those tokens straight off
// StyleData, so without the same augmentation they read empty while the PDF
// beside them prints the translated text.
//
// This module is the pure half of closing that gap: given the layout
// definitions an output set declares, report the languages the augmentation
// has to cover. The loader (styles/render-context.ts) does the DB-backed
// augmentation with it.
// =====================================================

export type LayoutTranslationLangs = {
  // {{composition:<lang>}} — translated from the style's own composition text.
  composition: string[];
} & Required<TranslatedFieldLangs>;

// The token keys that resolve through the translation bank, paired with the
// TranslatedFieldLangs slot they feed. {{careInstructions:<lang>}} is the odd
// one out — its slot is named `care`.
const TRANSLATED_TOKENS: Array<[keyof TranslatedFieldLangs, string]> = [
  ["care", "careInstructions"],
  ["madeIn", "madeIn"],
  ["madeInLabel", "madeInLabel"],
  ["country", "country"],
  ["countryOfOriginLabel", "countryOfOriginLabel"],
  ["manufacturer", "manufacturer"],
];

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.toLowerCase()))];
}

// Collect every language argument the given layouts print, across all the
// translation-bank-backed tokens. Empty arrays mean "this layout set prints
// nothing in that field", which the augmenters treat as a no-op.
export function translatedLangsInDefs(defs: readonly LayoutDef[]): LayoutTranslationLangs {
  const out: LayoutTranslationLangs = {
    composition: [],
    care: [],
    madeIn: [],
    madeInLabel: [],
    country: [],
    countryOfOriginLabel: [],
    manufacturer: [],
  };
  const acc: Record<string, string[]> = {
    composition: [],
    care: [],
    madeIn: [],
    madeInLabel: [],
    country: [],
    countryOfOriginLabel: [],
    manufacturer: [],
  };
  for (const def of defs) {
    acc.composition.push(...compositionLangsInDef(def));
    for (const [slot, tokenKey] of TRANSLATED_TOKENS) {
      acc[slot].push(...langArgsInDef(def, tokenKey));
    }
  }
  for (const key of Object.keys(out) as Array<keyof LayoutTranslationLangs>) {
    out[key] = dedupe(acc[key]);
  }
  return out;
}

// Does this layout set print anything that needs the translation bank? Lets
// the loader skip the dictionary round-trips entirely for the common case
// (a layout with no per-language tokens at all).
export function needsTranslationAugment(langs: LayoutTranslationLangs): boolean {
  return Object.values(langs).some((v) => v.length > 0);
}
