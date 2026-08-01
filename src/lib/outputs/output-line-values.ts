import { db, type DbClient } from "@/lib/db";
import { isLineKey, lineOverrideKey, MAX_LINE_LENGTH } from "@/lib/output-layouts/line-keys";

// =====================================================
// Per-(style × output × line) reviewer text overrides — "on THIS style's copy
// of THIS output, print THIS instead of what the layout says on that line".
//
// The catch-all beside output-field-values.ts. A FIELD value fixes DATA and so
// fixes every output that prints it; a LINE value rewrites one line of one
// document — including a line that is hardcoded in the layout and backed by no
// column at all ("Inner box: 8 pair"), which no field edit can reach. 437 of
// the catalogue's 1,574 authored lines are literals of exactly that kind.
//
// Prefer a field edit when one exists: it keeps the value tracking Monday and
// applies everywhere. A line edit is the escape hatch for what fields can't
// express, and freezes that line for this document.
//
// The stored `value` is a SOURCE line, not literal output — the renderer runs
// it through the same conditional + token pass as an authored line, so a
// reviewer can type plain text ("Inner box: 5 pair") OR repoint the line at a
// token ("Inner box: {{qtyPerCarton:inner}} pair"). Plain text simply contains
// no tokens and passes through verbatim.
//
// Keyed by variantKey exactly like StyleOutputFieldValue: the BASE key
// ("layout:<id>") applies to EVERY PDF of the output, "<base>#<suffix>" to one
// document of a repeat-per-EAN set. The review UI writes the base by default —
// a hardcoded literal is identical on every PDF, so editing it once should fix
// all of them — with a per-document toggle for the cases where it isn't.
//
// EVERY read is fail-soft: style_output_line_values is additive and may not be
// deployed yet. Until it lands the loaders return empty and the feature is
// dormant — never a 500, never a poisoned pg pool on fan-out dashboard reads.
// =====================================================

// lineKey → override source line, for one (style, output).
export type StyleLineValues = Record<string, string>;

// Re-exported so server callers need one import (the addressing itself is
// client-safe and shared with the review UI).
export { isLineKey, lineOverrideKey, MAX_LINE_LENGTH };

// Sanitise a loaded/incoming map: keep only non-blank string values under a
// plausible key, trimmed to the schema's line cap. A blank value is NOT kept —
// clearing an override is how a reviewer reverts a line to the layout's own
// text, so blanks are deletions, handled by the save path.
function cleanValues(raw: Record<string, unknown>): StyleLineValues {
  const out: StyleLineValues = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isLineKey(k)) continue;
    if (typeof v !== "string" || !v.trim()) continue;
    out[k] = v.trim().slice(0, MAX_LINE_LENGTH);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Availability probe — one shared probe rather than a missing-table error per
// concurrent caller (the dashboards load ~200 styles at once, and erroring on
// every one takes the pg adapter down). Table there → remembered for the
// process lifetime; missing → re-probed after a minute, so a pre-db:deploy
// server stays fast and starts working the moment the migration lands.
// Copied from output-field-values.ts / output-ignores.ts.
// ---------------------------------------------------------------------------
let availability: Promise<boolean> | null = null;
let recheckAt = 0;

function tableAvailable(): Promise<boolean> {
  if (availability == null || Date.now() >= recheckAt) {
    recheckAt = Number.MAX_SAFE_INTEGER; // in-flight probe holds the slot
    availability = db.styleOutputLineValue
      .findFirst({ select: { id: true } })
      .then(() => true) // recheckAt stays MAX — never probe again
      .catch(() => {
        recheckAt = Date.now() + 60_000;
        return false;
      });
  }
  return availability;
}

// The style's per-output line overrides, grouped by variantKey (base AND
// "base#suffix" keys both appear — the caller splits them, as the runner does
// for field values). Empty map when the table isn't deployed or on any
// transient failure — never let the lookup break its caller.
export async function loadStyleLineValues(
  styleId: string,
  client: DbClient = db,
): Promise<Map<string, StyleLineValues>> {
  const map = new Map<string, StyleLineValues>();
  if (!(await tableAvailable())) return map;
  try {
    const rows = await client.styleOutputLineValue.findMany({
      where: { styleId },
      select: { variantKey: true, lineKey: true, value: true },
    });
    for (const r of rows) {
      if (!isLineKey(r.lineKey) || !r.value.trim()) continue;
      const existing = map.get(r.variantKey) ?? {};
      existing[r.lineKey] = r.value;
      map.set(r.variantKey, existing);
    }
  } catch {
    return new Map();
  }
  return map;
}

// A frozen empty inner map for the `?? EMPTY` read pattern.
export const EMPTY_LINE_VALUES: ReadonlyMap<string, StyleLineValues> = new Map();

// Split a loaded map into the whole-output overrides for `baseKey` and the
// per-document ones keyed by suffix — the shape the runner threads into
// render / renderMany. Mirrors the field-value split in runner.ts.
export function splitLineValues(
  all: ReadonlyMap<string, StyleLineValues>,
  baseKey: string,
): { base: StyleLineValues | undefined; perDoc: Map<string, StyleLineValues> } {
  const prefix = `${baseKey}#`;
  const perDoc = new Map<string, StyleLineValues>();
  for (const [k, v] of all) {
    if (k.startsWith(prefix)) perDoc.set(k.slice(prefix.length), v);
  }
  return { base: all.get(baseKey), perDoc };
}

// Merge the whole-output overrides with one document's — per-document wins,
// line by line. Returns undefined when neither side has anything, so the
// renderer can skip the lookup entirely on the overwhelmingly common path.
export function mergeLineValues(
  base: StyleLineValues | undefined,
  perDoc: StyleLineValues | undefined,
): StyleLineValues | undefined {
  const baseHas = base && Object.keys(base).length > 0;
  const docHas = perDoc && Object.keys(perDoc).length > 0;
  if (!baseHas && !docHas) return undefined;
  if (!docHas) return base;
  if (!baseHas) return perDoc;
  return { ...base, ...perDoc };
}

// Upsert the reviewer's line overrides for one (style, output-or-document).
// Non-blank values are written; keys explicitly present but blank are DELETED
// (clearing a line reverts it to the layout's own text). Keys absent from the
// request are left untouched. Returns the resulting clean map.
//
// Throws on a real DB error — a missing table throws here on purpose, so the
// save endpoint reports "not deployed yet" rather than silently no-op'ing.
export async function saveStyleOutputLineValues(
  styleId: string,
  variantKey: string,
  values: Record<string, unknown>,
  opts: { outputName?: string | null; updatedById?: string | null } = {},
): Promise<StyleLineValues> {
  const clean = cleanValues(values);
  const present = Object.keys(values).filter(isLineKey);
  const toDelete = present.filter((k) => !(k in clean));

  await db.$transaction([
    ...toDelete.map((lineKey) =>
      db.styleOutputLineValue.deleteMany({ where: { styleId, variantKey, lineKey } }),
    ),
    ...Object.entries(clean).map(([lineKey, value]) =>
      db.styleOutputLineValue.upsert({
        where: { styleId_variantKey_lineKey: { styleId, variantKey, lineKey } },
        create: {
          styleId,
          variantKey,
          lineKey,
          value,
          outputName: opts.outputName ?? null,
          updatedById: opts.updatedById ?? null,
        },
        update: {
          value,
          outputName: opts.outputName ?? undefined,
          updatedById: opts.updatedById ?? null,
        },
      }),
    ),
  ]);
  return clean;
}
