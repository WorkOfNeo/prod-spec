// One-off seed runner that mirrors the admin POST endpoints without an
// HTTP session: seeds the standard languages (idempotent, skip-existing)
// and the standard translations (merge-safe upsert by normalised key).
// Run: npx tsx --env-file=.env scripts/seed-standard-translations.ts

import { db } from "@/lib/db";
import { STANDARD_LANGUAGES } from "@/lib/languages/seed";
import { STANDARD_TRANSLATIONS, STANDARD_CARE_LABELS } from "@/lib/translations/seed";
import { normaliseTranslationKey } from "@/lib/translations/lookup";

async function main() {
  // Languages — create only the missing codes (matches the route).
  let langCreated = 0;
  let langSkipped = 0;
  for (const seed of STANDARD_LANGUAGES) {
    const existing = await db.language.findUnique({ where: { code: seed.code } });
    if (existing) {
      langSkipped++;
      continue;
    }
    await db.language.create({
      data: {
        code: seed.code,
        name: seed.name,
        nativeName: seed.nativeName,
        sortOrder: seed.sortOrder,
        active: true,
      },
    });
    langCreated++;
  }
  console.log(`languages: ${langCreated} created, ${langSkipped} skipped`);

  // Translations — merge existing + seed (seed authoritative for its
  // langs, preserves any board-synced ones), upsert by normalised key.
  const now = new Date();
  let trCreated = 0;
  let trUpdated = 0;
  for (const seed of STANDARD_TRANSLATIONS) {
    const key = normaliseTranslationKey(seed.sourceText);
    const existing = await db.translation.findUnique({ where: { key } });
    const mergedTranslations = {
      ...((existing?.translations as Record<string, string> | undefined) ?? {}),
      ...seed.translations,
    };
    await db.translation.upsert({
      where: { key },
      create: {
        key,
        sourceText: seed.sourceText,
        translations: mergedTranslations as object,
        category: seed.category,
        active: true,
        lastSyncedAt: now,
      },
      update: {
        sourceText: seed.sourceText,
        translations: mergedTranslations as object,
        category: existing?.category ?? seed.category,
        active: true,
      },
    });
    if (existing) trUpdated++;
    else trCreated++;
    console.log(`  · ${key.slice(0, 60)}${key.length > 60 ? "…" : ""}`);
  }
  console.log(`translations: ${trCreated} created, ${trUpdated} updated`);

  // Care labels — one row per standard clause, idempotent by sourceText.
  // Rules start empty (always shown); configure show/hide in the admin UI.
  let clCreated = 0;
  let clSkipped = 0;
  for (const seed of STANDARD_CARE_LABELS) {
    const existing = await db.careLabel.findFirst({
      where: { sourceText: { equals: seed.sourceText, mode: "insensitive" } },
    });
    if (existing) {
      clSkipped++;
      continue;
    }
    await db.careLabel.create({
      data: { sourceText: seed.sourceText, sortOrder: seed.sortOrder },
    });
    clCreated++;
  }
  console.log(`care labels: ${clCreated} created, ${clSkipped} skipped`);

  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
