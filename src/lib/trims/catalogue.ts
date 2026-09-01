// =====================================================
// The packaging-row catalogue, read from and written to trim_concept_rows.
// SERVER-ONLY (imports db). The pure shape, the seed and the synchronous
// registry live in ./concepts, which stays client-safe.
//
// WHY A LOADER AND A REGISTRY RATHER THAN AWAIT-EVERYWHERE. conceptHasArtwork
// is called from inside assembleTrimManifest — a pure, synchronous function
// that the runner calls per style, per output. Making the catalogue async would
// push `await` through the manifest assembler, the copy resolver and the census
// for a lookup in a 21-row map. So the shape is the one the layout registry
// already uses: an async entry point loads the table and installs it, and the
// synchronous readers below that point resolve from what was installed.
//
// The entry point is loadTrimConceptRows, called by loadTrimSettings — which
// the runner, the regen sweep, the cover diff, the census and the per-style DB
// read all already go through, so there is one place to remember rather than
// twenty.
//
// FAIL-SOFT IN ONE DIRECTION ONLY. A missing table (P2021 — Railway runs
// migrate deploy before start, but a rolled-back deploy or a fresh branch
// database can still get here first), a dropped connection, or an empty table
// all fall back to the seed in ./concepts. That is precisely the behaviour this
// app had before the table existed, so the failure mode is "yesterday's
// covers", never "every concept suddenly unknown".
//
// NO TTL, NO CACHE. The table is 21 rows on a screen a person edits a few times
// a year; loadTrimSettings already issues three AppSetting reads beside it. A
// cache here would only add a window in which a just-saved row is not yet
// printing, which is the exact confusion the Output Builder's autosave already
// costs us elsewhere.
// =====================================================

import { db } from "@/lib/db";
import {
  DEFAULT_TRIM_CONCEPT_ROWS,
  normalizeTrimConceptRows,
  setTrimConceptCatalogue,
  uniqueTrimConceptValue,
  type TrimConceptRow,
} from "./concepts";

type DbRow = {
  value: string;
  label: string;
  artwork: boolean;
  note: string | null;
  pendingStatus: string | null;
  deliveredStatus: string | null;
  sortOrder: number;
  builtIn: boolean;
  active: boolean;
};

// Column names differ from the field names on purpose: `note`/`pending`/
// `delivered` are what the render chain and the editor speak, while the columns
// spell the two statuses out so a person reading the schema cannot mistake
// `pending` for a workflow state of the row itself.
function fromDb(row: DbRow): TrimConceptRow {
  return normalizeTrimConceptRows([
    {
      value: row.value,
      label: row.label,
      artwork: row.artwork,
      note: row.note ?? undefined,
      pending: row.pendingStatus ?? undefined,
      delivered: row.deliveredStatus ?? undefined,
      sortOrder: row.sortOrder,
      builtIn: row.builtIn,
      active: row.active,
    },
  ])[0];
}

// Every row, active or not, in display order — and installed into the
// synchronous registry as a side effect.
//
// INACTIVE ROWS ARE LOADED TOO. A mapping or a layout pin may still name one,
// and dropping it from the registry would degrade that row to a title-cased id
// with no wording and (worse) an assumed artwork:true. The callers that OFFER
// rows filter on `active` themselves.
export async function loadTrimConceptRows(): Promise<TrimConceptRow[]> {
  let rows: TrimConceptRow[] = [];
  try {
    const found = await db.trimConceptRow.findMany({
      orderBy: [{ sortOrder: "asc" }, { value: "asc" }],
    });
    rows = found.map(fromDb).filter(Boolean);
  } catch (err) {
    // Deliberately not rethrown: see the header. A cover that prints yesterday's
    // vocabulary beats a generation run that dies on a settings read.
    console.warn("[trims] packaging rows unreadable, falling back to the seed:", err);
    rows = [];
  }
  if (rows.length === 0) rows = DEFAULT_TRIM_CONCEPT_ROWS;
  setTrimConceptCatalogue(rows);
  return rows;
}

// The rows a picker should offer: active only, in display order.
export function offerableRows(rows: ReadonlyArray<TrimConceptRow>): TrimConceptRow[] {
  return rows.filter((r) => r.active);
}

// Save the list wholesale — the editor holds every row and sends every row.
//
// NOTHING IS DELETED, EVER. A row a person "removed" is stored with active
// false, because the per-label mappings and the per-layout pins reference it by
// value and a hard delete would silently re-open every trim mapped to it. Rows
// absent from the payload are left exactly as they are for the same reason: a
// truncated request must not be able to empty the catalogue.
//
// Values are assigned here, not by the client. A row arriving without one is
// new: its value is derived from its label and made unique against everything
// already in the table, so two rows a person meant to keep apart can never
// collapse into one.
export async function saveTrimConceptRows(
  incoming: ReadonlyArray<Partial<TrimConceptRow> & { label?: string }>,
): Promise<TrimConceptRow[]> {
  const existing = await db.trimConceptRow.findMany({ select: { value: true } });
  const taken = new Set(existing.map((r) => r.value));

  // Assign values to new rows first, so a payload adding two rows with similar
  // labels gets two distinct values rather than one row overwriting the other.
  const withValues: Array<Partial<TrimConceptRow>> = [];
  for (const row of incoming) {
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (!label) continue;
    let value = typeof row.value === "string" ? row.value.trim() : "";
    if (!value || !taken.has(value)) {
      // Either brand new, or naming a value that does not exist yet — both are
      // "create", and both need a value nothing else is using.
      value = value && !taken.has(value) ? value : uniqueTrimConceptValue(label, taken);
    }
    if (!value) continue;
    taken.add(value);
    withValues.push({ ...row, value, label });
  }

  const normalized = normalizeTrimConceptRows(withValues);
  for (const row of normalized) {
    const data = {
      label: row.label,
      artwork: row.artwork,
      note: row.note ?? null,
      // Null, not undefined: clearing a wording has to clear the column, and
      // the artwork:false strip in normalizeTrimConceptRows has already emptied
      // these for a packing instruction.
      pendingStatus: row.pending ?? null,
      deliveredStatus: row.delivered ?? null,
      sortOrder: row.sortOrder,
      active: row.active,
    };
    await db.trimConceptRow.upsert({
      where: { value: row.value },
      // builtIn is set on create only: it records where the row came from, and
      // a client must not be able to relabel a row it invented as built in.
      create: { value: row.value, builtIn: false, ...data },
      update: data,
    });
  }

  return loadTrimConceptRows();
}
