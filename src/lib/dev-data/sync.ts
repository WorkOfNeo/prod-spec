import type pg from "pg";
import { syncTable, type TableResult } from "./copy";
import { pools } from "./pools";
import { PO_TABLES, REFERENCE_TABLES, SCOPE_COLUMN, type PoScope } from "./tables";
import { qi } from "./sql";

// The dev data loader: pick recent purchase orders from production, load them
// into the dev database, and keep them in sync. Production is only ever read
// (see pools.ts); everything is written to the dev database.
//
// Three small tables of its own live in the DEV database only, created on first
// use — they're not Prisma models, so main's schema never grows them:
// - dev_data_pos: the loaded POs and how their last sync went.
// - dev_data_ledger: every row the loader copied, with production's updatedAt
//   at the time, so a later sync can tell production's changes from dev's.
// - dev_data_meta: when reference data was last synced.

export type LoadedPo = {
  poNumber: string;
  loadedAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  syncEnabled: boolean;
  styleCount: number;
};

export type RecentPo = {
  poNumber: string;
  firstSeenAt: string;
  lastSeenAt: string;
  styleCount: number;
  customers: string[];
  suppliers: string[];
  loaded: boolean;
};

export type SyncSummary = { ok: boolean; ranAt: string; pos: string[]; tables: TableResult[]; error?: string; busy?: boolean };

async function ensureDevTables(dev: pg.Pool) {
  await dev.query(`
    CREATE TABLE IF NOT EXISTS dev_data_pos (
      po_number text PRIMARY KEY,
      loaded_at timestamptz NOT NULL DEFAULT now(),
      last_synced_at timestamptz,
      last_error text,
      sync_enabled boolean NOT NULL DEFAULT true,
      style_count integer NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS dev_data_ledger (
      tbl text NOT NULL,
      key text NOT NULL,
      scope text NOT NULL,
      prod_updated text,
      PRIMARY KEY (tbl, key)
    );
    CREATE INDEX IF NOT EXISTS dev_data_ledger_scope ON dev_data_ledger (scope, tbl);
    CREATE TABLE IF NOT EXISTS dev_data_meta (
      key text PRIMARY KEY,
      value text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/** Production ids for one scope level, used to narrow the next level down. */
async function prodIds(prod: pg.Pool, table: string, column: string, values: unknown) {
  const { rows } = await prod.query<{ id: string }>(
    `SELECT id FROM ${qi(table)} WHERE ${qi(column)} = ANY($1::text[])`,
    [values],
  );
  return rows.map((r) => r.id);
}

async function syncReference(prod: pg.Pool, dev: pg.Pool): Promise<TableResult[]> {
  const results: TableResult[] = [];
  for (const table of REFERENCE_TABLES) results.push(await syncTable(prod, dev, table, null, "ref"));
  await dev.query(
    `INSERT INTO dev_data_meta (key, value, updated_at) VALUES ('reference_synced_at', now()::text, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  );
  return results;
}

async function syncPo(prod: pg.Pool, dev: pg.Pool, po: string): Promise<{ results: TableResult[]; styleCount: number }> {
  const scopeName = `po:${po}`;
  const styleIds = await prodIds(prod, "styles", "poNumber", [po]);
  const jobIds = await prodIds(prod, "jobs", "styleId", styleIds);
  const ticketIds = await prodIds(prod, "rejection_tickets", "styleId", styleIds);
  const values: Record<PoScope, string[]> = { po: [po], style: styleIds, job: jobIds, ticket: ticketIds };

  const results: TableResult[] = [];
  for (const { table, scope } of PO_TABLES) {
    results.push(
      await syncTable(prod, dev, table, { where: `${qi(SCOPE_COLUMN[scope])} = ANY($1::text[])`, params: [values[scope]] }, scopeName),
    );
  }
  return { results, styleCount: styleIds.length };
}

/**
 * One sync run: reference data, then every PO (all loaded POs with sync on,
 * or just `only`). A Postgres advisory lock on the dev database keeps runs from
 * overlapping — the timer and a button press can't both copy at once.
 */
export async function runSync(only?: string[]): Promise<SyncSummary> {
  const { prod, dev } = pools();
  const ranAt = new Date().toISOString();
  await ensureDevTables(dev);
  const lock = await dev.connect();
  try {
    const got = await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('dev-data-sync')) AS ok`);
    if (!got.rows[0].ok) return { ok: false, busy: true, ranAt, pos: [], tables: [], error: "A sync is already running." };
    try {
      const pos = only?.length
        ? only
        : (await dev.query<{ po_number: string }>(`SELECT po_number FROM dev_data_pos WHERE sync_enabled ORDER BY loaded_at`)).rows.map(
            (r) => r.po_number,
          );
      const tables = await syncReference(prod, dev);
      // One PO failing doesn't hold up the others; its error is kept on its row.
      const errors: string[] = [];
      for (const po of pos) {
        try {
          const { results, styleCount } = await syncPo(prod, dev, po);
          tables.push(...results);
          await dev.query(
            `UPDATE dev_data_pos SET last_synced_at = now(), last_error = NULL, style_count = $2 WHERE po_number = $1`,
            [po, styleCount],
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`PO ${po}: ${message}`);
          await dev.query(`UPDATE dev_data_pos SET last_error = $2 WHERE po_number = $1`, [po, message]);
        }
      }
      return { ok: errors.length === 0, ranAt, pos, tables, ...(errors.length ? { error: errors.join("; ") } : {}) };
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext('dev-data-sync'))`);
    }
  } catch (err) {
    return { ok: false, ranAt, pos: only ?? [], tables: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    lock.release();
  }
}

/** Load POs into dev (or turn their sync back on) and copy them right away. */
export async function loadPos(poNumbers: string[]): Promise<SyncSummary> {
  const pos = [...new Set(poNumbers.map((p) => p.trim()).filter(Boolean))];
  const { dev } = pools();
  await ensureDevTables(dev);
  for (const po of pos) {
    await dev.query(
      `INSERT INTO dev_data_pos (po_number) VALUES ($1) ON CONFLICT (po_number) DO UPDATE SET sync_enabled = true`,
      [po],
    );
  }
  return runSync(pos);
}

export async function setPoSync(po: string, enabled: boolean) {
  const { dev } = pools();
  await ensureDevTables(dev);
  await dev.query(`UPDATE dev_data_pos SET sync_enabled = $2 WHERE po_number = $1`, [po, enabled]);
}

/**
 * Take a PO out of dev: delete every row copied for it, then its styles
 * (cascading to anything made in dev on them: jobs, PDFs, comments …), and
 * forget it in the ledger. Reference data stays. Every per-PO table keys on `id`.
 */
export async function removePo(po: string) {
  const { dev } = pools();
  await ensureDevTables(dev);
  const scope = `po:${po}`;
  const client = await dev.connect();
  try {
    await client.query("BEGIN");
    const copied = await client.query<{ tbl: string }>(`SELECT DISTINCT tbl FROM dev_data_ledger WHERE scope = $1`, [scope]);
    const known = new Set(PO_TABLES.map((t) => t.table));
    for (const { tbl } of copied.rows) {
      if (!known.has(tbl)) continue;
      await client.query(
        `DELETE FROM ${qi(tbl)} WHERE id IN (SELECT key FROM dev_data_ledger WHERE tbl = $1 AND scope = $2)`,
        [tbl, scope],
      );
    }
    await client.query(`DELETE FROM styles WHERE "poNumber" = $1`, [po]);
    await client.query(`DELETE FROM po_delivery_checks WHERE "poNumber" = $1`, [po]);
    await client.query(`DELETE FROM dev_data_ledger WHERE scope = $1`, [`po:${po}`]);
    await client.query(`DELETE FROM dev_data_pos WHERE po_number = $1`, [po]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listLoadedPos(): Promise<{ pos: LoadedPo[]; referenceSyncedAt: string | null }> {
  const { dev } = pools();
  await ensureDevTables(dev);
  const [pos, meta] = await Promise.all([
    dev.query<{
      po_number: string;
      loaded_at: Date;
      last_synced_at: Date | null;
      last_error: string | null;
      sync_enabled: boolean;
      style_count: number;
    }>(`SELECT * FROM dev_data_pos ORDER BY loaded_at DESC`),
    dev.query<{ updated_at: Date }>(`SELECT updated_at FROM dev_data_meta WHERE key = 'reference_synced_at'`),
  ]);
  return {
    pos: pos.rows.map((r) => ({
      poNumber: r.po_number,
      loadedAt: r.loaded_at.toISOString(),
      lastSyncedAt: r.last_synced_at?.toISOString() ?? null,
      lastError: r.last_error,
      syncEnabled: r.sync_enabled,
      styleCount: r.style_count,
    })),
    referenceSyncedAt: meta.rows[0]?.updated_at.toISOString() ?? null,
  };
}

/**
 * The POs that came into production most recently (by when their newest style
 * was created), with who they're for. `search` narrows to PO numbers containing it.
 */
export async function listRecentPos({ search = "", limit = 60 }: { search?: string; limit?: number } = {}): Promise<RecentPo[]> {
  const { prod, dev } = pools();
  await ensureDevTables(dev);
  const { rows } = await prod.query<{
    po: string;
    first_seen: Date;
    last_seen: Date;
    styles: string;
    customers: string[];
    suppliers: string[];
  }>(
    `SELECT s."poNumber" AS po, min(s."createdAt") AS first_seen, max(s."createdAt") AS last_seen, count(*)::text AS styles,
            array_remove(array_agg(DISTINCT c.name), NULL) AS customers,
            array_remove(array_agg(DISTINCT sup.name), NULL) AS suppliers
       FROM styles s
       JOIN customers c ON c.id = s."customerId"
       LEFT JOIN suppliers sup ON sup.id = s."supplierId"
      WHERE s."poNumber" IS NOT NULL AND s."poNumber" <> '' AND s."deletedAt" IS NULL
        AND ($1 = '' OR s."poNumber" ILIKE '%' || $1 || '%')
      GROUP BY s."poNumber"
      ORDER BY max(s."createdAt") DESC
      LIMIT $2`,
    [search.trim(), Math.min(Math.max(limit, 1), 200)],
  );
  const loaded = new Set((await dev.query<{ po_number: string }>(`SELECT po_number FROM dev_data_pos`)).rows.map((r) => r.po_number));
  return rows.map((r) => ({
    poNumber: r.po,
    firstSeenAt: r.first_seen.toISOString(),
    lastSeenAt: r.last_seen.toISOString(),
    styleCount: Number(r.styles),
    customers: r.customers,
    suppliers: r.suppliers,
    loaded: loaded.has(r.po),
  }));
}
