// scripts/dev-data.ts
//
// The dev data loader from the command line — the same code the /dev-data
// page runs. Reads production (PROD_READ_DATABASE_URL), writes DATABASE_URL,
// and refuses to run if the two are the same database.
//
//   DEV_DATA_LOADER=true tsx scripts/dev-data.ts recent [search]   POs that came in most recently
//   DEV_DATA_LOADER=true tsx scripts/dev-data.ts load <po> [<po> …] load POs and copy them now
//   DEV_DATA_LOADER=true tsx scripts/dev-data.ts sync              sync reference data + every loaded PO
//   DEV_DATA_LOADER=true tsx scripts/dev-data.ts status            what's loaded and when it last synced
//   DEV_DATA_LOADER=true tsx scripts/dev-data.ts remove <po>       take a PO out of the dev database
//
// On Railway: `railway run --environment development --service prod-spec-dev
// npx tsx scripts/dev-data.ts status` (the dev service has both URLs set).

import { listLoadedPos, listRecentPos, loadPos, removePo, runSync, type SyncSummary } from "../src/lib/dev-data/sync";
import { pools } from "../src/lib/dev-data/pools";

function printSummary(s: SyncSummary) {
  const changed = s.tables.filter((t) => t.copied || t.deleted || t.skipped);
  for (const t of changed) {
    console.log(`  ${t.table.padEnd(32)} ${t.skipped ? `skipped (${t.skipped})` : `${t.copied} copied, ${t.deleted} deleted`}`);
  }
  if (!changed.length) console.log("  nothing changed");
  console.log(s.ok ? `✓ synced ${s.pos.length} PO(s)` : `✗ ${s.error}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "recent": {
      for (const p of await listRecentPos({ search: args[0] ?? "", limit: 30 })) {
        console.log(
          `${p.loaded ? "●" : " "} ${p.poNumber.padEnd(14)} ${String(p.styleCount).padStart(3)} styles  ${p.lastSeenAt.slice(0, 10)}  ${p.customers.join(", ")}`,
        );
      }
      break;
    }
    case "load": {
      if (!args.length) throw new Error("Give at least one PO number.");
      printSummary(await loadPos(args));
      break;
    }
    case "sync":
      printSummary(await runSync());
      break;
    case "status": {
      const { pos, referenceSyncedAt } = await listLoadedPos();
      console.log(`reference data synced: ${referenceSyncedAt ?? "never"}`);
      for (const p of pos) {
        console.log(
          `${p.syncEnabled ? "↻" : "‖"} ${p.poNumber.padEnd(14)} ${String(p.styleCount).padStart(3)} styles  last sync ${p.lastSyncedAt ?? "never"}${p.lastError ? `  ERROR ${p.lastError}` : ""}`,
        );
      }
      break;
    }
    case "remove": {
      if (!args[0]) throw new Error("Give a PO number.");
      await removePo(args[0]);
      console.log(`removed PO ${args[0]} from the dev database`);
      break;
    }
    default:
      console.log("Usage: dev-data.ts recent [search] | load <po…> | sync | status | remove <po>");
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const p = pools();
      await Promise.all([p.prod.end(), p.dev.end()]);
    } catch {
      // pools() throws when the loader is off — nothing to close.
    }
  });
