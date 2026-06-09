import { db } from "@/lib/db";

// Normalise an English phrase to the Translation.key form: trim, collapse
// internal whitespace, lowercase. The Monday sync (which WRITES keys) and
// the renderer (which READS them) MUST normalise identically — otherwise a
// phrase that synced as "made in china" won't resolve a lookup of
// "Made in China".
export function normaliseTranslationKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export type TranslationEntry = {
  sourceText: string;
  translations: Record<string, string>;
};

// In-memory dictionary: normalised English key → entry. Built once per
// render job from the active Translation rows so per-phrase lookups are
// O(1) and don't hit the DB.
export type TranslationDictionary = Map<string, TranslationEntry>;

export async function loadTranslationDictionary(): Promise<TranslationDictionary> {
  const rows = await db.translation.findMany({
    where: { active: true },
    select: { key: true, sourceText: true, translations: true },
  });
  const map: TranslationDictionary = new Map();
  for (const r of rows) {
    map.set(r.key, {
      sourceText: r.sourceText,
      translations: (r.translations ?? {}) as Record<string, string>,
    });
  }
  return map;
}

// Resolve an English phrase into `lang`. Resolution order:
//   1. the dictionary's per-language value, when present and non-empty
//   2. the dictionary's stored English source
//   3. the caller's phrase verbatim (phrase isn't in the dictionary at all)
// Never throws and never returns empty for a non-empty input — a missing
// translation degrades to English rather than a blank label line.
export function translatePhrase(
  dict: TranslationDictionary,
  english: string,
  lang: string,
): string {
  const entry = dict.get(normaliseTranslationKey(english));
  if (!entry) return english;
  const t = entry.translations[lang];
  if (typeof t === "string" && t.trim()) return t;
  return entry.sourceText || english;
}

// Translate a textile composition string per language by translating each
// MATERIAL term against the board while preserving the percentages and
// structure. The board stores fibre names ("organic cotton", "recycled
// polyester"), NOT full "NN% Material" strings — so a whole-phrase lookup
// wouldn't match. We split on commas, peel the leading "NN%" off each
// segment, translate the remaining fibre name (translatePhrase, which
// degrades to the English fibre when the board lacks it), and reassemble.
//
//   "100% Organic Cotton"      --(da)-->  "100% Økologisk Bomuld"
//   "95% Cotton, 5% Elastane"  --(da)-->  "95% Bomuld, 5% Elastan"
//
// A segment without a leading percentage is translated whole. `changed`
// reports whether at least one fibre actually resolved to a non-English
// value, so callers can skip a language row that would otherwise just
// reprint the English composition under a foreign flag.
export function translateComposition(
  dict: TranslationDictionary,
  composition: string,
  lang: string,
): { text: string; changed: boolean } {
  let changed = false;
  const text = composition
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((segment) => {
      const m = segment.match(/^(\d+(?:[.,]\d+)?)\s*%\s*(.+)$/);
      const material = m ? m[2] : segment;
      const translated = translatePhrase(dict, material, lang);
      if (translated !== material) changed = true;
      return m ? `${m[1]}% ${translated}` : translated;
    })
    .join(", ");
  return { text, changed };
}
