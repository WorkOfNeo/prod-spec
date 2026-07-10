import { db, type DbClient } from "@/lib/db";
import { ignoreBaseKey } from "@/lib/outputs/output-ignores";
import { isPinnableField, parseFieldOverrides, type PinnableField } from "@/lib/pdf/pins-meta";

// =====================================================
// Per-(style × output × field) reviewer-supplied field values — "on THIS
// style's copy of THIS output, use this string for this field". Set inline on
// the review surfaces: fill a missing/blocked field so the output can generate,
// or override a value on an already-generated one.
//
// A per-style value is just a per-STYLE `fieldOverrides` map that composes with
// the ProdSpec output's per-OUTPUT `fieldOverrides` pins — the per-style value
// wins. Both flow through the SAME two mechanisms, so filling a field here is
// indistinguishable from an admin pin downstream:
//   • readiness / the runner gate:  pinnedColumnKeys(mergeFieldOverrides(...))
//     → the field counts as filled, so the output stops being skipped and
//     generates (see output-readiness.ts / runner.ts).
//   • render:  applyFieldOverrides(styleData, mergeFieldOverrides(...))
//     → the value prints (see pins.ts).
//
// Keyed by the BASE variantKey (ignoreBaseKey — a multi-document
// "<base>#<suffix>" collapses to its base), matching StyleOutputIgnore and the
// supplier-send queue. Only PinnableField keys are stored (structured/derived
// fields — sizes, EANs, wash care — stay authoritative and are not editable).
//
// EVERY read is fail-soft: the style_output_field_values table is additive and
// may not be deployed yet (db:deploy pending). Until it lands, loaders return
// empty and the feature is simply dormant — never a 500, never a poisoned pg
// pool on the fan-out dashboard reads.
// =====================================================

// The per-output override map: pinnable field key → reviewer value.
export type StyleFieldValues = Partial<Record<PinnableField, string>>;

// Re-export the base-key convention so callers (readiness, the save endpoint,
// the UI) all key values the same way.
export { ignoreBaseKey } from "@/lib/outputs/output-ignores";

// Merge a ProdSpec output's raw `fieldOverrides` (admin pins) with the
// per-style reviewer values for that output — per-style wins. The result is a
// clean pin map safe to hand to `pinnedColumnKeys` (readiness) and
// `applyFieldOverrides` (render), both of which re-sanitise. Returns the pins
// unchanged when there are no per-style values, so non-feature paths are inert.
export function mergeFieldOverrides(
  prodSpecRaw: unknown,
  perStyle: StyleFieldValues | undefined,
): StyleFieldValues {
  const pins = parseFieldOverrides(prodSpecRaw);
  if (!perStyle || Object.keys(perStyle).length === 0) return pins;
  return { ...pins, ...perStyle };
}

// Sanitise a loaded/incoming map: keep only pinnable keys with non-blank
// string values (mirrors parseFieldOverrides, but over an already-keyed map).
function cleanValues(raw: Record<string, unknown>): StyleFieldValues {
  const out: StyleFieldValues = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isPinnableField(k)) continue;
    if (typeof v !== "string" || !v.trim()) continue;
    out[k] = v.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Availability probe. Fail-soft must not mean fail-often: the dashboards call
// the loaders for ~200 styles CONCURRENTLY, and a missing-table error on every
// one takes the whole pg adapter down (RangeError + hung pool). So the first
// caller issues ONE probe every concurrent caller shares: table there →
// remembered for the process lifetime; table missing → remembered for a minute,
// so a pre-db:deploy server stays fast and starts working the moment the
// migration lands. Copied from output-ignores.ts.
// ---------------------------------------------------------------------------
let availability: Promise<boolean> | null = null;
let recheckAt = 0;

function tableAvailable(): Promise<boolean> {
  if (availability == null || Date.now() >= recheckAt) {
    recheckAt = Number.MAX_SAFE_INTEGER; // in-flight probe holds the slot
    availability = db.styleOutputFieldValue
      .findFirst({ select: { id: true } })
      .then(() => true) // recheckAt stays MAX — never probe again
      .catch(() => {
        recheckAt = Date.now() + 60_000;
        return false;
      });
  }
  return availability;
}

// The style's per-output field values, grouped by BASE variantKey. Empty map
// when the table isn't deployed yet or on any transient failure — never let the
// lookup break its caller. Each inner map is a clean StyleFieldValues.
export async function loadStyleFieldValues(
  styleId: string,
  client: DbClient = db,
): Promise<Map<string, StyleFieldValues>> {
  const map = new Map<string, StyleFieldValues>();
  if (!(await tableAvailable())) return map;
  try {
    const rows = await client.styleOutputFieldValue.findMany({
      where: { styleId },
      select: { variantKey: true, field: true, value: true },
    });
    for (const r of rows) {
      if (!isPinnableField(r.field) || !r.value.trim()) continue;
      const existing = map.get(r.variantKey) ?? {};
      existing[r.field] = r.value.trim();
      map.set(r.variantKey, existing);
    }
  } catch {
    return new Map();
  }
  return map;
}

// Batch flavour for list surfaces (needs-input scan, dashboards) — one query
// for all styles. Styles with no values are absent from the outer map; read via
// `byStyle.get(id) ?? EMPTY_FIELD_VALUES`.
export async function loadStyleFieldValuesByStyle(
  styleIds: string[],
): Promise<Map<string, Map<string, StyleFieldValues>>> {
  const byStyle = new Map<string, Map<string, StyleFieldValues>>();
  if (styleIds.length === 0) return byStyle;
  if (!(await tableAvailable())) return byStyle;
  try {
    const rows = await db.styleOutputFieldValue.findMany({
      where: { styleId: { in: styleIds } },
      select: { styleId: true, variantKey: true, field: true, value: true },
    });
    for (const r of rows) {
      if (!isPinnableField(r.field) || !r.value.trim()) continue;
      const inner = byStyle.get(r.styleId) ?? new Map<string, StyleFieldValues>();
      const vals = inner.get(r.variantKey) ?? {};
      vals[r.field] = r.value.trim();
      inner.set(r.variantKey, vals);
      byStyle.set(r.styleId, inner);
    }
  } catch {
    return new Map();
  }
  return byStyle;
}

// A frozen empty inner map for the `?? EMPTY` read pattern above.
export const EMPTY_FIELD_VALUES: ReadonlyMap<string, StyleFieldValues> = new Map();

// Upsert the reviewer's values for one (style, base output). Non-blank values
// are written (create or update); blank/removed fields are DELETED (clearing a
// field reverts it to the row-resolved value). Non-pinnable keys are ignored.
// Returns the resulting clean value map for the output. Runs in one transaction
// off the global client (request-time mutation). Throws on a real DB error — a
// missing table throws here on purpose so the save endpoint reports "not
// deployed yet" rather than silently no-op'ing.
export async function saveStyleOutputFieldValues(
  styleId: string,
  variantKey: string,
  values: Record<string, unknown>,
  opts: { outputName?: string | null; updatedById?: string | null } = {},
): Promise<StyleFieldValues> {
  const clean = cleanValues(values);
  // Which pinnable keys were explicitly present in the request (even if blank)
  // → those cleared to blank get deleted. Keys absent from the request are left
  // untouched.
  const present = Object.keys(values).filter(isPinnableField) as PinnableField[];
  const toDelete = present.filter((f) => !(f in clean));

  await db.$transaction([
    ...toDelete.map((field) =>
      db.styleOutputFieldValue.deleteMany({ where: { styleId, variantKey, field } }),
    ),
    ...(Object.entries(clean) as [PinnableField, string][]).map(([field, value]) =>
      db.styleOutputFieldValue.upsert({
        where: { styleId_variantKey_field: { styleId, variantKey, field } },
        create: {
          styleId,
          variantKey,
          field,
          value,
          outputName: opts.outputName ?? null,
          updatedById: opts.updatedById ?? null,
        },
        update: { value, outputName: opts.outputName ?? undefined, updatedById: opts.updatedById ?? null },
      }),
    ),
  ]);
  return clean;
}
