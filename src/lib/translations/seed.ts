// Standard translations we ship with — phrases that are "always the same
// data" across styles and want to render even before the Monday board
// (9671510799) is synced. Seeded idempotently via POST /api/admin/translations
// ({ seedStandard: true }); the board sync later reconciles/extends these.
//
// Keys are Language.code (lowercase ISO 639-1). The renderer looks these up
// through src/lib/translations/lookup.ts.
//
// Care text is seeded two ways from the same clause data:
//   • one canonical FULL-phrase entry (all clauses joined) — reference text
//   • one entry PER clause — so the DB-managed care labels (which key on
//     each clause's English sourceText) translate out of the box.
// Care labels themselves live in the CareLabel table (/settings/care-labels);
// the renderer resolves each label's per-language text through this dictionary.

import {
  STANDARD_CARE_CLAUSES,
  STANDARD_CARE_INSTRUCTION_EN,
  composeCareInstruction,
} from "./care-clauses";
import type { LaunderingAction } from "@/lib/care-labels/actions";

export { STANDARD_CARE_INSTRUCTION_EN };

export type TranslationSeed = {
  sourceText: string;
  category: string;
  translations: Record<string, string>;
};

// Every language any clause carries — the canonical phrase is the join of
// all clauses (none suppressed) for that language.
const CARE_LANGS = Array.from(
  new Set(STANDARD_CARE_CLAUSES.flatMap((c) => Object.keys(c.translations))),
);
const careInstructionTranslations: Record<string, string> = {};
for (const lang of CARE_LANGS) {
  careInstructionTranslations[lang] = composeCareInstruction(STANDARD_CARE_CLAUSES, lang);
}

// One dictionary entry per clause — keyed by the clause's English text,
// which is exactly the sourceText a standard CareLabel row carries.
const clauseTranslations: TranslationSeed[] = STANDARD_CARE_CLAUSES.map((c) => ({
  sourceText: c.translations.en,
  category: "Care instructions",
  translations: c.translations,
}));

// Note: "Made in <country>" phrases are NOT seeded here — they live on the
// Monday translations board (full phrases per country, e.g. "Made in China")
// and reach the renderer through the synced Translation dictionary. Keeping
// them out of the app keeps the wording editable from Monday.
export const STANDARD_TRANSLATIONS: TranslationSeed[] = [
  {
    sourceText: STANDARD_CARE_INSTRUCTION_EN,
    category: "Care instructions",
    translations: careInstructionTranslations,
  },
  ...clauseTranslations,
];

// The standard care-label lines we ship — one per clause, in print order.
// Seeded into the CareLabel table (idempotent by sourceText). Each carries its
// laundering `action` so prohibition symbols auto-remove it; the manual
// show/hide rules start empty and are configured per label in the admin UI.
export const STANDARD_CARE_LABELS: Array<{
  sourceText: string;
  sortOrder: number;
  action: LaunderingAction | null;
}> = STANDARD_CARE_CLAUSES.map((c, i) => ({
  sourceText: c.translations.en,
  sortOrder: i,
  action: c.action,
}));
