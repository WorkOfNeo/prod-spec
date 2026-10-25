// Pure SQL helpers for the dev data loader (copying rows from production into
// a development database that runs the same Prisma schema). No database
// access here, so everything is unit-tested in sql.test.ts.
//
// Values travel as TEXT and are cast back to the column's own type on insert
// (`$1::jsonb`, `$2::"StyleStatus"`, `$3::timestamp(3) without time zone`), so
// timestamps, enums, JSON and arrays round-trip exactly without node-postgres
// re-interpreting them. bytea is the one exception: it stays binary.

/** A column as Postgres describes it: `format_type()` output for the type. */
export type Column = { name: string; type: string };

/** Quote an identifier for SQL. */
export function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function isBytes(col: Column): boolean {
  return col.type === "bytea";
}

/** The columns both databases have, in the dev database's order. */
export function sharedColumns(dev: Column[], prod: Column[]): Column[] {
  const inProd = new Set(prod.map((c) => c.name));
  return dev.filter((c) => inProd.has(c.name));
}

/** A SELECT list that reads every column as text, except bytea which stays binary. */
export function selectList(cols: Column[]): string {
  return cols.map((c) => (isBytes(c) ? qi(c.name) : `${qi(c.name)}::text AS ${qi(c.name)}`)).join(", ");
}

/**
 * `($1::type, $2::type), ($3::type, …)` for `rowCount` rows, each cast back to
 * its column type.
 */
export function valuesClause(cols: Column[], rowCount: number): string {
  const rows: string[] = [];
  let n = 1;
  for (let r = 0; r < rowCount; r++) {
    rows.push(`(${cols.map((c) => `$${n++}::${c.type}`).join(", ")})`);
  }
  return rows.join(", ");
}

/**
 * Upsert from a staging table into the real one: insert every staged row, and
 * on a primary-key clash overwrite every copied column. Columns the dev
 * database has but production doesn't are left to their defaults on insert
 * and untouched on update.
 */
export function upsertFromStaging(table: string, cols: Column[], pk: string, staging: string): string {
  const names = cols.map((c) => qi(c.name)).join(", ");
  const updates = cols.filter((c) => c.name !== pk).map((c) => `${qi(c.name)} = EXCLUDED.${qi(c.name)}`);
  const onConflict = updates.length ? `DO UPDATE SET ${updates.join(", ")}` : "DO NOTHING";
  return `INSERT INTO ${qi(table)} (${names}) SELECT ${names} FROM ${qi(staging)} ON CONFLICT (${qi(pk)}) ${onConflict}`;
}

/**
 * Before an upsert, remove dev rows that would collide with an incoming row on
 * a non-primary unique index (same email, same `(styleId, variantKey)` …) but
 * are a different row. Those are dev-local leftovers of the same thing, e.g. a
 * user who signed up in dev before production's users were loaded.
 */
export function deleteUniqueClashes(table: string, uniqueCols: string[], pk: string, staging: string): string {
  const match = uniqueCols.map((c) => `t.${qi(c)} = s.${qi(c)}`).join(" AND ");
  return `DELETE FROM ${qi(table)} t USING ${qi(staging)} s WHERE ${match} AND t.${qi(pk)} <> s.${qi(pk)}`;
}

/**
 * Split rows into batches that stay under Postgres's bind-parameter limit and,
 * for rows carrying PDFs, under a byte budget so one INSERT never holds
 * hundreds of megabytes.
 */
export function batches<T extends unknown[]>(
  rows: T[],
  { maxParams = 30000, maxBytes = 32 * 1024 * 1024 }: { maxParams?: number; maxBytes?: number } = {},
): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let params = 0;
  let bytes = 0;
  for (const row of rows) {
    const rowBytes = row.reduce<number>((sum, v) => sum + (Buffer.isBuffer(v) ? v.length : 0), 0);
    if (current.length && (params + row.length > maxParams || bytes + rowBytes > maxBytes)) {
      out.push(current);
      current = [];
      params = 0;
      bytes = 0;
    }
    current.push(row);
    params += row.length;
    bytes += rowBytes;
  }
  if (current.length) out.push(current);
  return out;
}

/** Split a list into chunks of at most `size`. */
export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Which rows to copy, given production's rows (key → last-changed time) and the
 * ledger of what was copied before (key → production's last-changed time then).
 *
 * - Not in the ledger: new from production, copy it.
 * - In the ledger and production changed it since: copy it again (production's
 *   change wins, even over a dev edit of the same row).
 * - In the ledger and unchanged in production: leave it. Whatever dev did to it
 *   (edited, deleted) stays.
 * Tables without an updatedAt column are append-only: copy new keys only.
 */
export function rowsToCopy(prod: Map<string, string | null>, ledger: Map<string, string | null>): string[] {
  const keys: string[] = [];
  for (const [key, updated] of prod) {
    if (!ledger.has(key)) {
      keys.push(key);
      continue;
    }
    const seen = ledger.get(key);
    if (updated !== null && seen !== null && seen !== undefined && updated > seen) keys.push(key);
  }
  return keys;
}

/** Ledger keys production no longer has: delete them from dev. */
export function rowsGoneFromProd(prod: Map<string, string | null>, ledger: Map<string, string | null>): string[] {
  return [...ledger.keys()].filter((key) => !prod.has(key));
}

type DbTarget = { host: string; port: string; database: string };

function target(url: string): DbTarget | null {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), port: u.port || "5432", database: u.pathname.replace(/^\//, "") };
  } catch {
    return null;
  }
}

/**
 * Do two connection strings point at the same database? The loader refuses to
 * run when they do: the dev app must never treat production as its own.
 * Unparseable URLs count as "same" so the check fails closed.
 */
export function sameDatabase(a: string, b: string): boolean {
  const x = target(a);
  const y = target(b);
  if (!x || !y) return true;
  return x.host === y.host && x.port === y.port && x.database === y.database;
}
