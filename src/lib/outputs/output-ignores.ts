import { db, type DbClient } from "@/lib/db";

// =====================================================
// Per-(style × output) operator ignores — "this output is not wanted for THIS
// style". Set from the Ignore button on the review surfaces (between Reject
// and Approve), undone by deleting the row.
//
// An ignore is the per-style sibling of the doc-type keyword exclusion rules:
// it feeds outputReadinessForStyle's `excluded` flag (with `ignored: true` so
// the UI can tell them apart), which is the shared source every consumer —
// runner, auto-enqueue, review page, dashboards — already reads. On top of
// that, the publish paths (SharePoint upload, supplier-send queue, per-output
// delivery) filter ignored outputs so an already-generated asset never ships.
//
// EVERY read here is fail-soft: the style_output_ignores table is additive and
// may not be deployed yet (db:deploy pending) — until it lands, loaders return
// empty and the feature is simply dormant.
// =====================================================

// The reason text surfaced wherever an exclusion reason shows (review page,
// style page cards, rejection-log workbench).
export const IGNORED_EXCLUSION_REASON = "ignored for this style by a reviewer";

// The per-output identity an ignore is keyed by: the BASE variantKey (a
// multi-document "<base>#<suffix>" collapses to its base), falling back to
// "doc:<TYPE>" for legacy assets without a variantKey — the same collapse the
// supplier-send queue and current-outputs use.
export function ignoreBaseKey(variantKey: string | null, docType: string): string {
  const v = (variantKey ?? "").split("#")[0];
  return v || `doc:${docType}`;
}

// Availability probe. Fail-soft must not mean fail-often: the dashboards call
// the loaders for ~200 styles CONCURRENTLY, and a missing-table error on every
// one of those queries takes the whole pg adapter down (RangeError + hung
// pool, observed on the dev server). So the first caller issues ONE probe that
// every concurrent caller shares: table there → remembered for the process
// lifetime (tables don't un-deploy); table missing → remembered for a minute,
// so a pre-db:deploy server stays fast and starts working the moment the
// migration lands (next probe).
let availability: Promise<boolean> | null = null;
let recheckAt = 0;

function tableAvailable(): Promise<boolean> {
  if (availability == null || Date.now() >= recheckAt) {
    recheckAt = Number.MAX_SAFE_INTEGER; // in-flight probe holds the slot
    availability = db.styleOutputIgnore
      .findFirst({ select: { id: true } })
      .then(() => true) // recheckAt stays MAX — never probe again
      .catch(() => {
        recheckAt = Date.now() + 60_000;
        return false;
      });
  }
  return availability;
}

// The style's ignored base keys. Empty set when the table isn't deployed yet
// or on any transient failure — never let the ignore lookup break its caller.
export async function loadIgnoredOutputKeys(
  styleId: string,
  client: DbClient = db,
): Promise<Set<string>> {
  if (!(await tableAvailable())) return new Set();
  try {
    const rows = await client.styleOutputIgnore.findMany({
      where: { styleId },
      select: { variantKey: true },
    });
    return new Set(rows.map((r) => r.variantKey));
  } catch {
    return new Set();
  }
}

// Batch flavour for list surfaces (styles table, dashboards, bulk re-runs) —
// one query for all styles. Styles with no ignores are absent from the map;
// read via `ignoredByStyle.get(id) ?? EMPTY`.
export async function loadIgnoredOutputKeysByStyle(
  styleIds: string[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (styleIds.length === 0) return map;
  if (!(await tableAvailable())) return map;
  try {
    const rows = await db.styleOutputIgnore.findMany({
      where: { styleId: { in: styleIds } },
      select: { styleId: true, variantKey: true },
    });
    for (const r of rows) {
      const set = map.get(r.styleId);
      if (set) set.add(r.variantKey);
      else map.set(r.styleId, new Set([r.variantKey]));
    }
  } catch {
    // Transient failure — nothing ignored this render.
  }
  return map;
}
