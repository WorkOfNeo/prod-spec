import { sameDatabase } from "./sql";

// The dev data loader copies production data into a DEVELOPMENT database: it
// reads production through PROD_READ_DATABASE_URL and writes only to its own
// DATABASE_URL. It exists only where DEV_DATA_LOADER=true is set (the Railway
// `development` environment); production never sets it, so there the page,
// the API and the background sync don't exist at all.
//
// Server-side only — components receive the resolved boolean as props; never
// read process.env in client code.
export function devDataLoaderEnabled(): boolean {
  return process.env.DEV_DATA_LOADER === "true" && Boolean(process.env.PROD_READ_DATABASE_URL);
}

/** How often loaded POs re-sync, in minutes (DEV_DATA_SYNC_MINUTES, default 10). */
export function devDataSyncMinutes(): number {
  const n = Number(process.env.DEV_DATA_SYNC_MINUTES);
  return Number.isInteger(n) && n > 0 ? n : 10;
}

/**
 * Throws unless the loader may run: switched on, both databases configured and
 * — the guard that matters — the database it writes to is NOT production.
 */
export function assertDevDataLoaderSafe(): { prodUrl: string; devUrl: string } {
  const prodUrl = process.env.PROD_READ_DATABASE_URL;
  const devUrl = process.env.DATABASE_URL;
  if (process.env.DEV_DATA_LOADER !== "true") throw new Error("The dev data loader is off (DEV_DATA_LOADER is not true).");
  if (!prodUrl) throw new Error("PROD_READ_DATABASE_URL is not set.");
  if (!devUrl) throw new Error("DATABASE_URL is not set.");
  if (sameDatabase(prodUrl, devUrl)) {
    throw new Error("Refusing to run: DATABASE_URL points at the production database.");
  }
  return { prodUrl, devUrl };
}
