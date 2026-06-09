// DESTRUCTIVE — clears all Style rows (and their Jobs + JobAssets via FK
// cascade) so you can rebuild cleanly from the Pre-Order board.
//
// Run it yourself when ready, then re-sync styles:
//   npx tsx --env-file=.env scripts/wipe-styles.ts
//
// Leaves customers, suppliers, business areas, prod specs, ghost mirrors,
// and app settings untouched.
import { db } from "@/lib/db";

async function main() {
  const styles = await db.style.count();
  const jobs = await db.job.count();
  console.log(`Deleting ${styles} styles (+ ${jobs} jobs and their assets via cascade)…`);

  const res = await db.style.deleteMany({});

  console.log(`✓ Deleted ${res.count} styles.`);
  console.log(
    "Now re-sync from the Pre-Order board (Sync page / Fill). " +
      "Make sure the Pre-Order board is sunk first so the ghost mirror is fresh.",
  );
  process.exit(0);
}

main();
