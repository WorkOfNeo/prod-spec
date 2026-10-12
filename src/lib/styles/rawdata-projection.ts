import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { MANUAL_COLUMN_IDS, type ColumnMapping } from "@/lib/customers/config";

// =====================================================
// rawData projection for the /styles list. Style.rawData is the whole Monday
// item (~150 column_values, file/long-text payloads included), and the list
// loads it for every active style — thousands of rows, almost all of it
// columns the list never looks at. This trims column_values IN SQL to the
// ones the list path can read, so they never cross the wire.
//
// What the list path reads from rawData (audited — keep in sync if one of
// these starts reading the item differently):
//   • effectiveStyleItem — `!item`, the item's other top-level fields (spread
//     through untouched), column_values[].id/.text for the manual.* fallback
//     ids it injects under.
//   • resolveMappedField — column_values.find(c => c.id === id) for
//     id = mapping[field] (when set) and MANUAL_COLUMN_IDS[field], reading
//     .text then .display_value. Every other reader goes through it:
//     findMissingDetailFields, outputReadinessForStyle (each variant's
//     requiredFields, its `readiness` hook, the output/doc-type rule fields —
//     all are handed the resolver, never the item), and the visible
//     resolved-field columns.
//   • styleReadinessNotice / computeReadiness / computeEffectiveStatus never
//     see rawData, and no MONDAY_*_COLS constant is read on this path.
// So the only ids that can ever match are the values of the customer column
// mappings in play (DEFAULT_COLUMN_MAPPING merged in) plus the manual.* ids.
//
// Two shapes are kept on purpose because a lookup CAN still land on them:
//   • non-object entries (null, strings, arrays) — `find` evaluates `x.id` on
//     them, so dropping one could turn a TypeError into a value or vice versa;
//   • objects with no "id" key — a rule on a field that isn't a ColumnMapping
//     key resolves MANUAL_COLUMN_IDS[field] === undefined, which matches the
//     first id-less entry.
// Kept entries stay whole and in their original order (`find` returns the
// FIRST match, and duplicate ids exist), so every lookup the list makes sees
// exactly what it would on the full item. Anything that isn't an object with
// a column_values array passes through unchanged.
// =====================================================

// The column ids the list path can read, for the customer mappings it will
// resolve against (parseCustomerConfig(...).columnMapping — defaults already
// merged). Computed per request from the live mappings, so a new mapping
// takes effect without a deploy.
export function listPathColumnIds(mappings: Iterable<Partial<ColumnMapping>>): string[] {
  const ids = new Set<string>(Object.values(MANUAL_COLUMN_IDS));
  for (const mapping of mappings) {
    for (const id of Object.values(mapping)) if (typeof id === "string" && id) ids.add(id);
  }
  return [...ids].sort();
}

function keepColumnValue(c: unknown, columnIds: ReadonlySet<string>): boolean {
  if (c === null || typeof c !== "object" || Array.isArray(c)) return true;
  if (!("id" in c)) return true;
  const id = (c as { id: unknown }).id;
  return typeof id === "string" && columnIds.has(id);
}

// The same projection in JS — the reference the SQL below is tested against
// (and what the parity script compares rows for).
export function projectRawData(raw: unknown, columnIds: ReadonlySet<string>): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const cols = (raw as { column_values?: unknown }).column_values;
  if (!Array.isArray(cols)) return raw;
  return { ...raw, column_values: cols.filter((c) => keepColumnValue(c, columnIds)) };
}

// rawData for the given styles, projected in Postgres to `columnIds` (see
// above); the result maps style id → projected item.
//
// rawData is TOASTed (compressed, out of line), and every reference to the
// column in an expression fetches and decompresses it again. The OFFSET 0
// lateral reads it ONCE into an in-memory copy (jsonb_path_query_first(x,
// '$') is x itself, whatever its JSON type) that the projection then reuses.
// The CASE keeps the per-entry work to one id lookup for the entries dropped,
// which is nearly all of them; it is keepColumnValue in SQL.
//
// That per-entry filter is CPU-bound in Postgres, so the ids go in chunks
// run side by side — several backends share a ~4k-style list instead of one
// doing it all.
const PROJECTION_CHUNK = 1000;

export async function loadProjectedRawData(
  styleIds: string[],
  columnIds: readonly string[],
): Promise<Map<string, unknown>> {
  const ids = [...columnIds];
  const chunks: string[][] = [];
  for (let i = 0; i < styleIds.length; i += PROJECTION_CHUNK) {
    chunks.push(styleIds.slice(i, i + PROJECTION_CHUNK));
  }
  const results = await Promise.all(
    chunks.map((chunk) =>
      db.$queryRaw<Array<{ id: string; rawData: unknown }>>(Prisma.sql`
        SELECT s.id,
               CASE
                 WHEN jsonb_typeof(r.raw -> 'column_values') = 'array' THEN
                   jsonb_set(r.raw, '{column_values}', COALESCE((
                     SELECT jsonb_agg(cv ORDER BY ord)
                       FROM jsonb_array_elements(r.raw -> 'column_values') WITH ORDINALITY AS e(cv, ord)
                      WHERE CASE
                              WHEN jsonb_typeof(cv) <> 'object' THEN true
                              WHEN cv ->> 'id' = ANY(${ids}::text[]) THEN jsonb_typeof(cv -> 'id') = 'string'
                              ELSE NOT (cv ? 'id')
                            END
                   ), '[]'::jsonb))
                 ELSE r.raw
               END AS "rawData"
          FROM styles s
         CROSS JOIN LATERAL (SELECT jsonb_path_query_first(s."rawData", '$') AS raw OFFSET 0) r
         WHERE s.id = ANY(${chunk}::text[])`),
    ),
  );
  const out = new Map<string, unknown>();
  for (const rows of results) for (const r of rows) out.set(r.id, r.rawData);
  return out;
}
