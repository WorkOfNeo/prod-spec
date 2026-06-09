import { db } from "@/lib/db";
import { MONDAY_BOARDS } from "./boards";
import { readGhostColumnText } from "@/lib/import/heuristics";
import { normaliseTranslationKey } from "@/lib/translations/lookup";

// Translations board (9671510799) column-title → Language.code. Titles are
// matched case-insensitively (lowercased + trimmed). Alternate spellings are
// included so a tidied-up Monday header ("Czech", "Portuguese") still maps.
//
// The board's two empty "English" columns ("angielski", "Engelsk") have no
// entry here and are skipped — the item Name IS the English source. Codes
// match src/lib/languages/seed.ts (28 languages incl. en + 27 board cols).
const TITLE_TO_LANG: Record<string, string> = {
  danish: "da",
  swedish: "sv",
  norwegian: "no",
  finnish: "fi",
  german: "de",
  polish: "pl",
  croatian: "hr",
  slovenian: "sl",
  czhecian: "cs",
  czech: "cs",
  slovakian: "sk",
  slovak: "sk",
  hungarian: "hu",
  austrian: "de-AT",
  swiss: "de-CH",
  italian: "it",
  romanian: "ro",
  "dutch (netherlands)": "nl",
  dutch: "nl",
  french: "fr",
  spanish: "es",
  bulgarian: "bg",
  macedonian: "mk",
  turkish: "tr",
  iceland: "is",
  icelandic: "is",
  greek: "el",
  irish: "ga",
  portugese: "pt",
  portuguese: "pt",
  moldovian: "ro-MD",
  moldovan: "ro-MD",
  belgian: "nl-BE",
};

// Empty English placeholder columns on the board — recognised so they don't
// show up as "unmapped" noise in the sync report.
const ENGLISH_PLACEHOLDER_TITLES = new Set(["angielski", "engelsk", "english"]);

export type TranslationSyncResult = {
  columnsMapped: number;
  // Text columns we couldn't map to a language — surfaced so the operator
  // notices if a board header was renamed out of sync with TITLE_TO_LANG.
  unmappedColumns: string[];
  itemsScanned: number;
  translationsUpserted: number;
};

// Transform the already-sunk Translations ghost board into the Translation
// dictionary. Reads ghost columns/items only — run the board sink first.
//
// Never deletes: re-runs upsert every English phrase and merge its language
// values. Board duplicates of the same English phrase collapse onto one row
// (their translations are merged; last non-empty value per language wins).
export async function syncTranslations(): Promise<TranslationSyncResult> {
  const board = await db.mondayGhostBoard.findUnique({
    where: { mondayBoardId: MONDAY_BOARDS.translations },
    select: { id: true },
  });
  if (!board) {
    throw new Error(
      `Translations ghost mirror is empty — sink board ${MONDAY_BOARDS.translations} ` +
        `first (POST /api/admin/monday/sink?boardId=${MONDAY_BOARDS.translations}).`,
    );
  }

  // Resolve each language column id from its title.
  const columns = await db.mondayGhostColumn.findMany({
    where: { boardId: board.id },
    select: { mondayColumnId: true, title: true, type: true },
  });
  const langColumns: Array<{ code: string; columnId: string }> = [];
  const unmappedColumns: string[] = [];
  for (const col of columns) {
    const title = col.title.trim().toLowerCase();
    const code = TITLE_TO_LANG[title];
    if (code) {
      langColumns.push({ code, columnId: col.mondayColumnId });
      continue;
    }
    // Only flag text columns we expected to be languages. Name/Date/Subitems
    // and the known-empty English placeholders aren't a concern.
    if (col.type === "text" && !ENGLISH_PLACEHOLDER_TITLES.has(title)) {
      unmappedColumns.push(col.title);
    }
  }

  const items = await db.mondayGhostItem.findMany({
    where: { boardId: board.id },
    select: { mondayItemId: true, name: true, groupTitle: true, columnValues: true },
  });

  type Acc = {
    key: string;
    sourceText: string;
    category: string | null;
    mondayItemId: string;
    translations: Record<string, string>;
  };
  const byKey = new Map<string, Acc>();

  for (const item of items) {
    const sourceText = (item.name ?? "").trim();
    if (!sourceText) continue;
    const key = normaliseTranslationKey(sourceText);
    if (!key) continue;

    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        key,
        sourceText,
        category: item.groupTitle ?? null,
        mondayItemId: item.mondayItemId,
        // Seed en from the English source so tFor(translations, "en")
        // resolves uniformly with every other language.
        translations: { en: sourceText },
      };
      byKey.set(key, acc);
    }
    for (const { code, columnId } of langColumns) {
      const text = readGhostColumnText(item.columnValues, columnId);
      if (text) acc.translations[code] = text;
    }
  }

  const now = new Date();
  let translationsUpserted = 0;
  for (const acc of byKey.values()) {
    await db.translation.upsert({
      where: { key: acc.key },
      create: {
        key: acc.key,
        sourceText: acc.sourceText,
        translations: acc.translations as object,
        category: acc.category,
        mondayItemId: acc.mondayItemId,
        active: true,
        lastSyncedAt: now,
      },
      update: {
        sourceText: acc.sourceText,
        translations: acc.translations as object,
        category: acc.category,
        mondayItemId: acc.mondayItemId,
        active: true,
        lastSyncedAt: now,
      },
    });
    translationsUpserted++;
  }

  return {
    columnsMapped: langColumns.length,
    unmappedColumns,
    itemsScanned: items.length,
    translationsUpserted,
  };
}
