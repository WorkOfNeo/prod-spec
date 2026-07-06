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
  // Imported lazily so the pure helpers below (translatePhrase /
  // translateComposition) can be imported — and unit-tested — without pulling
  // in the Prisma client or requiring DATABASE_URL.
  const { db } = await import("@/lib/db");
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
// wouldn't match. A fibre clause is "<NN%> <fibre name>"; clauses may
// follow each other WITHOUT a comma ("92% Polyester 8% Elastane"), so
// clauses are delimited by the next percentage token, not by punctuation.
// Each clause's fibre name translates via translatePhrase (which degrades
// to the English fibre when the board lacks it); everything around the
// fibre names — percentages, spacing, slashes, prefixes — is preserved.
//
//   "100% Organic Cotton"        --(da)-->  "100% Økologisk Bomuld"
//   "95% Cotton, 5% Elastane"    --(da)-->  "95% Bomuld, 5% Elastan"
//   "92% Polyester 8% Elastane"  --(da)-->  "92% Polyester 8% Elastan"
//
// Multi-part compositions head each section with a "<label>:" ("Top:",
// "Skirt:", "Shell:", "Lining:", …) and string the parts together — usually
// space-separated, no comma between them. The label word is ALSO a board
// lookup, and a fibre name STOPS before the next label so it resolves on its
// own instead of swallowing the following label:
//
//   "Top: 100% Cotton Skirt: 100% Polyester"
//                                --(da)-->  "Overdel: 100% Bomuld Nederdel: 100% Polyester"
//
// A comma segment without any percentage is translated whole. `changed`
// reports whether at least one term actually resolved to a non-English
// value, so callers can skip a language row that would otherwise just
// reprint the English composition under a foreign flag.
export function translateComposition(
  dict: TranslationDictionary,
  composition: string,
  lang: string,
): { text: string; changed: boolean } {
  let changed = false;

  // "<NN%> <fibre…>" where the fibre runs lazily up to the next percentage
  // token, the next part label ("<space><word>:"), or the end of the segment
  // — so "100% Cotton Skirt:" captures "Cotton", not "Cotton Skirt".
  const PERCENT_CLAUSE =
    /(\d+(?:[.,]\d+)?\s*%\s*)([^%]+?)(?=\s*\d+(?:[.,]\d+)?\s*%|\s+[^\s%:,]+\s*:|$)/g;

  const translateFibreClauses = (segment: string): string =>
    segment.replace(PERCENT_CLAUSE, (whole, pct: string, fibreRaw: string) => {
      // Trim separators (spaces, slashes, …) off the fibre but splice the
      // translation back between them so authored punctuation survives.
      const fibre = fibreRaw.replace(/^[\s/;:·•-]+|[\s/;:·•-]+$/g, "");
      if (!fibre) return whole;
      const translated = translatePhrase(dict, fibre, lang);
      if (translated !== fibre) changed = true;
      return pct + fibreRaw.replace(fibre, translated);
    });

  // Section labels: the word before each "<word>:" is looked up on the board
  // (degrading to English) with the colon and its spacing preserved. A no-op
  // on single-part compositions, which carry no labels.
  const PART_LABEL = /([^\s%:,]+)(\s*:)/g;
  const translatePartLabels = (segment: string): string =>
    segment.replace(PART_LABEL, (_whole, label: string, colon: string) => {
      const translated = translatePhrase(dict, label, lang);
      if (translated !== label) changed = true;
      return translated + colon;
    });

  const text = composition
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((segment) => {
      // Fibres first (their capture stops before the next label), then the
      // part labels heading each section.
      if (/\d\s*%/.test(segment)) return translatePartLabels(translateFibreClauses(segment));
      const translated = translatePhrase(dict, segment, lang);
      if (translated !== segment) changed = true;
      return translated;
    })
    .join(", ");
  return { text, changed };
}
