// Run the ghost-DB sink against every known Monday board.
// Run: npx tsx --env-file=.env scripts/sink-all-smoke.ts

import { sinkAllKnownBoards } from "@/lib/monday/sink";
import { db } from "@/lib/db";

async function main() {
  console.log("Sinking all known boards...\n");
  const { results, failed } = await sinkAllKnownBoards();

  console.log("\n=== Results ===");
  for (const r of results) {
    console.log(
      `  ${r.key.padEnd(10)} ${r.boardId.padEnd(11)} "${r.mondayBoardName}" — ${r.itemsSynced}/${r.itemsTotal} items, ${r.columnsSynced} cols, ${r.dropdownOptionsSynced} options (${Math.round(r.durationMs / 100) / 10}s)`,
    );
  }
  if (failed.length > 0) {
    console.log("\n=== Failures ===");
    for (const f of failed) console.log(`  ${f.key} ${f.boardId} — ${f.error}`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
