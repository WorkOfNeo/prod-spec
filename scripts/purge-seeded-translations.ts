// Purge the Translation rows that came from the retired "Seed standard set"
// feature, leaving ONLY Monday-sourced rows behind.
//
// How we tell them apart: the Monday sync (src/lib/monday/translations.ts)
// always stamps `mondayItemId`. The old seed never did. So every row with
// `mondayItemId = NULL` is seed-only and safe to drop — UNLESS that phrase
// isn't on the Monday board yet, in which case deleting it strips its
// translations from every label that prints it.
//
// SAFE ORDER:
//   1. Add any in-use phrase below to the Monday translations board + sync
//      ("Sync from Monday" on /translations). Syncing stamps mondayItemId,
//      so the phrase drops OFF this purge list automatically.
//   2. Re-run this in dry-run mode and confirm the remaining list is genuine
//      cruft (e.g. the composed "… / … / …" reference phrase).
//   3. Re-run with --delete.
//
// Dry run (default, lists only):  npx tsx --env-file=.env scripts/purge-seeded-translations.ts
// Delete for real:                npx tsx --env-file=.env scripts/purge-seeded-translations.ts --delete

import { db } from "@/lib/db";

async function main() {
  const doDelete = process.argv.includes("--delete");

  const seeded = await db.translation.findMany({
    where: { mondayItemId: null },
    select: { id: true, key: true, sourceText: true, category: true, translations: true },
    orderBy: { sourceText: "asc" },
  });

  if (seeded.length === 0) {
    console.log("No seed-only rows (mondayItemId IS NULL) — nothing to purge.");
    await db.$disconnect();
    return;
  }

  console.log(`${seeded.length} seed-only row(s) (mondayItemId IS NULL):\n`);
  for (const r of seeded) {
    const langs = Object.keys((r.translations ?? {}) as Record<string, string>)
      .filter((c) => c !== "en")
      .sort();
    console.log(`  • "${r.sourceText}"`);
    console.log(`      key=${r.key}  category=${r.category ?? "—"}  langs=[${langs.join(", ") || "none"}]`);
  }

  if (!doDelete) {
    console.log(
      `\nDRY RUN — nothing deleted. Make sure every phrase above that should ` +
        `keep translating is on the Monday board and synced first, then re-run ` +
        `with --delete.`,
    );
    await db.$disconnect();
    return;
  }

  const { count } = await db.translation.deleteMany({ where: { mondayItemId: null } });
  console.log(`\nDeleted ${count} seed-only row(s). Monday is now the sole source.`);
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
