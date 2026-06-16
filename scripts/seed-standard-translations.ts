// One-off seed runner that mirrors the admin POST endpoints without an
// HTTP session: seeds the standard languages (idempotent, skip-existing)
// and the standard care-label ROWS (idempotent by sourceText).
//
// Care-label per-language TEXT is NOT seeded — it resolves through the
// Translation dictionary, whose only source is the Monday translations board
// (synced at /translations). Add or edit wording there, then sync.
// Run: npx tsx --env-file=.env scripts/seed-standard-translations.ts

import { db } from "@/lib/db";
import { STANDARD_LANGUAGES } from "@/lib/languages/seed";
import { STANDARD_CARE_LABELS } from "@/lib/translations/seed";

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
