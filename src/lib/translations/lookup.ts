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
// space-separated, no comma between them. The label is ALSO a board lookup,
// and a fibre name STOPS before the next label so it resolves on its own
// instead of swallowing the following label:
//
//   "Top: 100% Cotton Skirt: 100% Polyester"
//                                --(da)-->  "Overdel: 100% Bomuld Nederdel: 100% Polyester"
//
// A label may run several words ("Outer Fabric :"). Nothing in the text says
// where such a label starts — "100% Cotton Outer Fabric:" reads either way —
// so the BOARD decides: the longest run of words before the colon (up to
// MAX_LABEL_WORDS) that the board knows is the label, else just the one word
// before the colon. A fibre clause always keeps at least its first word.
//
//   "Outer Fabric : 100% Polyester Lining : 100% Cotton"
//                                --(da)-->  "Yderstof : 100% Polyester For : 100% Bomuld"
//
// A comma segment without any percentage is translated whole. `changed`
// reports whether at least one term actually resolved to a non-English
// value, so callers can skip a language row that would otherwise just
// reprint the English composition under a foreign flag.
const MAX_LABEL_WORDS = 4;

export function translateComposition(
  dict: TranslationDictionary,
  composition: string,
  lang: string,
): { text: string; changed: boolean } {
  let changed = false;

  // "<NN%> <fibre…>" where the fibre runs lazily up to the next percentage
  // token or the end of the text. Only ever run on a part's VALUE — the text
  // between two labels — so a following label can't be swallowed.
  const PERCENT_CLAUSE = /(\d+(?:[.,]\d+)?\s*%\s*)([^%]+?)(?=\s*\d+(?:[.,]\d+)?\s*%|$)/g;

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

  // Section labels: each "<word>:" ends one. Its start is the longest run of
  // words before the colon the board knows (see above), bounded by the
  // previous label's colon and by the last fibre clause's first word; the
  // colon and its spacing are left in the value that follows. A segment with
  // no labels (a single-part composition) is one value.
  const PART_LABEL = /([^\s%:,]+)\s*:/g;
  const translateLabelledSegment = (segment: string): string => {
    let out = "";
    let cursor = 0; // start of the text not yet emitted
    let wordsFrom = 0; // just past the previous label's colon
    for (const m of segment.matchAll(PART_LABEL)) {
      const labelEnd = m.index + m[1].length;
      // Earlier words this label could start at, longest label first.
      const before = segment.slice(wordsFrom, m.index);
      const floor = before.lastIndexOf("%") + 1;
      const starts = [...before.slice(floor).matchAll(/\S+/g)].map((w) => wordsFrom + floor + w.index);
      if (floor > 0) starts.shift(); // the fibre clause keeps its first word
      let labelStart = m.index;
      for (const start of starts.slice(-(MAX_LABEL_WORDS - 1))) {
        if (dict.has(normaliseTranslationKey(segment.slice(start, labelEnd)))) {
          labelStart = start;
          break;
        }
      }
      const label = segment.slice(labelStart, labelEnd);
      const translated = translatePhrase(dict, label, lang);
      if (translated !== label) changed = true;
      out += translateFibreClauses(segment.slice(cursor, labelStart)) + translated;
      cursor = labelEnd;
      wordsFrom = m.index + m[0].length;
    }
    return out + translateFibreClauses(segment.slice(cursor));
  };

  const text = composition
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((segment) => {
      if (/\d\s*%/.test(segment)) return translateLabelledSegment(segment);
      const translated = translatePhrase(dict, segment, lang);
      if (translated !== segment) changed = true;
      return translated;
    })
    .join(", ");
  return { text, changed };
}
