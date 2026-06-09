// Standard care-instruction clauses — SEED DATA only.
//
// Care labels are now DB-managed (see src/lib/care-labels + the CareLabel
// table, edited at /settings/care-labels), and their per-language text
// comes from the Translation dictionary. This module is just the canonical
// shipped set used to seed both: one CareLabel row per clause, and one
// dictionary entry per clause (so the labels translate out of the box).
//
// Clauses are ATOMIC — one laundering action each — so a prohibition symbol
// can drop exactly the offending part and the renderer composes the survivors.
// That's why the old compound "wash and iron inside out" is shipped as two
// clauses: "wash inside out" (WASHING) + "iron inside out" (IRONING). With a
// "Do not iron" symbol present, the iron clause is removed and the line reads
// "wash inside out" — no separate rewrite step needed.

import type { LaunderingAction } from "@/lib/care-labels/actions";

export type CareClause = {
  id: string;
  // The laundering action this clause's text is about. Tags the seeded
  // CareLabel row so a restrictive symbol of the same action removes it.
  // null ⇒ never auto-suppressed.
  action: LaunderingAction | null;
  // Lowercase ISO 639-1 keys → localized clause text. `en` is the source.
  translations: Record<string, string>;
};

// One clause per slash-separated segment of the original phrase, in print
// order.
export const STANDARD_CARE_CLAUSES: CareClause[] = [
  {
    id: "wash-similar-colours",
    action: "WASHING",
    translations: {
      en: "Wash with similar colours",
      da: "vaskes med lignende farver",
      de: "Mit ähnlichen Farben waschen",
      fi: "pese samanväristen kanssa",
      no: "vaskes med lignende farger",
      sv: "tvätta med liknande färger",
      nl: "met soortgelijke kleuren wassen",
      fr: "Laver avec des couleurs similaires",
      pl: "prać z podobnymi kolorami",
    },
  },
  {
    id: "wash-before-wearing",
    action: "WASHING",
    translations: {
      en: "wash before wearing",
      da: "vaskes inden brug",
      de: "Vor dem Tragen waschen",
      fi: "pese ennen käyttöä",
      no: "vaskes før bruk",
      sv: "tvätta före användning",
      nl: "voor het dragen wassen",
      fr: "Laver avant de porter",
      pl: "wyprać przed pierwszym użyciem",
    },
  },
  // The old compound "wash and iron inside out" split into two atomic clauses
  // so "Do not iron" drops only the ironing half. Translations are the wash /
  // iron halves of the original compound phrase.
  {
    id: "wash-inside-out",
    action: "WASHING",
    translations: {
      en: "wash inside out",
      da: "vaskes med vrangen ud",
      de: "Auf links waschen",
      fi: "pese nurinpäin",
      no: "vaskes på vrangen",
      sv: "tvätta ut och in",
      nl: "binnenstebuiten wassen",
      fr: "Laver à l’envers",
      pl: "prać na lewej stronie",
    },
  },
  {
    id: "iron-inside-out",
    action: "IRONING",
    translations: {
      en: "iron inside out",
      da: "stryges med vrangen ud",
      de: "Auf links bügeln",
      fi: "silitä nurinpäin",
      no: "strykes på vrangen",
      sv: "stryk ut och in",
      nl: "binnenstebuiten strijken",
      fr: "repasser à l’envers",
      pl: "prasować na lewej stronie",
    },
  },
];

// Join clauses for one language into the full printed line. Clauses with
// no translation for `lang` are dropped. Used to seed the canonical
// full-phrase dictionary entry.
export function composeCareInstruction(clauses: CareClause[], lang: string): string {
  return clauses
    .map((c) => c.translations[lang]?.trim())
    .filter((s): s is string => !!s)
    .join(" / ");
}

// The full English source line (all clauses, no suppression). Doubles as
// the dictionary key for the canonical care phrase. Derived so the clause
// data stays the single source of truth.
export const STANDARD_CARE_INSTRUCTION_EN = STANDARD_CARE_CLAUSES.map(
  (c) => c.translations.en,
).join(" / ");
