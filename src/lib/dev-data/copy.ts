import type pg from "pg";
import {
  batches,
  chunk,
  deleteUniqueClashes,
  isBytes,
  qi,
  rowsGoneFromProd,
  rowsToCopy,
  selectList,
  sharedColumns,
  upsertFromStaging,
  valuesClause,
  type Column,
} from "./sql";

// Copies one table (or the slice of it a scope selects) from production into
// the dev database. Which rows move is decided against the ledger
// (dev_data_ledger): every row the loader ever copied, with production's
// updatedAt at the time. See rowsToCopy / rowsGoneFromProd in sql.ts.

export type Scope = { where: string; params: unknown[] } | null;

export type TableResult = { table: string; copied: number; deleted: number; skipped?: string };

type TableShape = { cols: Column[]; pk: string; uniques: string[][]; hasUpdated: boolean };

async function columnsOf(client: pg.Pool, table: string): Promise<Column[]> {
  const { rows } = await client.query<Column>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass('public.' || quote_ident($1)) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [table],
  );
  return rows;
}

async function shapeOf(prod: pg.Pool, dev: pg.Pool, table: string): Promise<TableShape | string> {
  const [devCols, prodCols] = await Promise.all([columnsOf(dev, table), columnsOf(prod, table)]);
  if (!devCols.length) return "not in the dev database";
  if (!prodCols.length) return "not in production";
  const keys = await dev.query<{ cols: string[]; primary: boolean }>(
    // ::text — node-postgres returns a `name[]` as an unparsed string; `text[]` arrives as an array.
    `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols, i.indisprimary AS primary
       FROM pg_index i
       CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = to_regclass('public.' || quote_ident($1))
        AND (i.indisprimary OR i.indisunique) AND i.indpred IS NULL AND i.indexprs IS NULL
      GROUP BY i.indexrelid, i.indisprimary`,
    [table],
  );
  const primary = keys.rows.filter((k) => k.primary);
  if (primary.length !== 1 || primary[0].cols.length !== 1) return "no single-column primary key";
  const cols = sharedColumns(devCols, prodCols);
  const names = new Set(cols.map((c) => c.name));
  return {
    cols,
    pk: primary[0].cols[0],
    // Only unique indexes whose columns are all copied can clash with an incoming row.
    uniques: keys.rows.filter((k) => !k.primary && k.cols.every((c) => names.has(c))).map((k) => k.cols),
    hasUpdated: names.has("updatedAt"),
  };
}

/** key → production's updatedAt (normalised to text), for the rows a scope selects. */
async function prodKeys(prod: pg.Pool, table: string, shape: TableShape, scope: Scope) {
  const updated = shape.hasUpdated ? `, to_char(${qi("updatedAt")}, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS u` : "";
  const { rows } = await prod.query<{ k: string; u?: string }>(
    `SELECT ${qi(shape.pk)}::text AS k${updated} FROM ${qi(table)}${scope ? ` WHERE ${scope.where}` : ""}`,
    scope?.params ?? [],
  );
  return new Map<string, string | null>(rows.map((r) => [r.k, r.u ?? null]));
}

async function ledgerKeys(dev: pg.Pool, table: string, scopeName: string) {
  const { rows } = await dev.query<{ key: string; prod_updated: string | null }>(
    `SELECT key, prod_updated FROM dev_data_ledger WHERE tbl = $1 AND scope = $2`,
    [table, scopeName],
  );
  return new Map<string, string | null>(rows.map((r) => [r.key, r.prod_updated]));
}

/** Writes one fetched batch: stage it, clear unique clashes, upsert, record it in the ledger. */
async function writeRows(
  dev: pg.Pool,
  table: string,
  shape: TableShape,
  rows: unknown[][],
  ledger: { keys: string[]; updated: (string | null)[]; scopeName: string },
) {
  const client = await dev.connect();
  try {
    await client.query("BEGIN");
    // Foreign keys are enforced by triggers; replica mode skips them so tables
    // can be copied in any order (and a row whose parent isn't loaded still lands).
    await client.query("SET LOCAL session_replication_role = replica");
    const names = shape.cols.map((c) => qi(c.name)).join(", ");
    await client.query(`CREATE TEMP TABLE "_in" ON COMMIT DROP AS SELECT ${names} FROM ${qi(table)} WITH NO DATA`);
    for (const batch of batches(rows)) {
      await client.query(`INSERT INTO "_in" (${names}) VALUES ${valuesClause(shape.cols, batch.length)}`, batch.flat());
    }
    for (const unique of shape.uniques) await client.query(deleteUniqueClashes(table, unique, shape.pk, "_in"));
    await client.query(upsertFromStaging(table, shape.cols, shape.pk, "_in"));
    await client.query(
      `INSERT INTO dev_data_ledger (tbl, key, scope, prod_updated)
       SELECT $1, k, $2, u FROM unnest($3::text[], $4::text[]) AS x(k, u)
       ON CONFLICT (tbl, key) DO UPDATE SET scope = EXCLUDED.scope, prod_updated = EXCLUDED.prod_updated`,
      [table, ledger.scopeName, ledger.keys, ledger.updated],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Bring one table's scoped slice in dev up to date with production:
 * copy rows that are new or changed in production, delete rows production
 * removed, and leave everything else (including dev's own edits) alone.
 */
export async function syncTable(
  prod: pg.Pool,
  dev: pg.Pool,
  table: string,
  scope: Scope,
  scopeName: string,
): Promise<TableResult> {
  const shape = await shapeOf(prod, dev, table);
  if (typeof shape === "string") return { table, copied: 0, deleted: 0, skipped: shape };

  const [prodMap, ledgerMap] = await Promise.all([prodKeys(prod, table, shape, scope), ledgerKeys(dev, table, scopeName)]);
  const toCopy = rowsToCopy(prodMap, ledgerMap);
  const gone = rowsGoneFromProd(prodMap, ledgerMap);

  // PDFs and images: few rows per read so a batch stays a few megabytes.
  const perRead = shape.cols.some(isBytes) ? 20 : 1000;
  for (const keys of chunk(toCopy, perRead)) {
    const { rows } = await prod.query<unknown[]>({
      text: `SELECT ${selectList(shape.cols)} FROM ${qi(table)} WHERE ${qi(shape.pk)}::text = ANY($1::text[])`,
      values: [keys],
      rowMode: "array",
    });
    const pkIndex = shape.cols.findIndex((c) => c.name === shape.pk);
    const fetched = rows.map((r) => String(r[pkIndex]));
    await writeRows(dev, table, shape, rows, {
      keys: fetched,
      updated: fetched.map((k) => prodMap.get(k) ?? null),
      scopeName,
    });
  }

  if (gone.length) {
    const client = await dev.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`DELETE FROM ${qi(table)} WHERE ${qi(shape.pk)}::text = ANY($1::text[])`, [gone]);
      await client.query(`DELETE FROM dev_data_ledger WHERE tbl = $1 AND key = ANY($2::text[])`, [table, gone]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { table, copied: toCopy.length, deleted: gone.length };
}
