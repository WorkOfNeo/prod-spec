import { devDataLoaderEnabled, devDataSyncMinutes } from "./flags";
import { runSync } from "./sync";

// Keeps loaded POs in sync while the dev server runs: one sync a minute after
// boot, then every DEV_DATA_SYNC_MINUTES (default 10). Started from
// src/instrumentation.ts, only where DEV_DATA_LOADER=true. runSync's advisory
// lock keeps a timer tick and a "Sync now" press from overlapping.

const globalForTimer = globalThis as unknown as { devDataTimer?: NodeJS.Timeout };

async function tick() {
  const s = await runSync();
  if (s.busy) return;
  const copied = s.tables.reduce((n, t) => n + t.copied, 0);
  const deleted = s.tables.reduce((n, t) => n + t.deleted, 0);
  if (s.ok) console.log(`[dev-data] synced ${s.pos.length} PO(s): ${copied} copied, ${deleted} deleted`);
  else console.error(`[dev-data] sync failed: ${s.error}`);
}

export function startDevDataSync() {
  if (!devDataLoaderEnabled() || globalForTimer.devDataTimer) return;
  setTimeout(() => void tick(), 60_000).unref();
  globalForTimer.devDataTimer = setInterval(() => void tick(), devDataSyncMinutes() * 60_000);
  globalForTimer.devDataTimer.unref();
}
