import { db } from "@/lib/db";
import { type CareLabel, toSymbolCodeArray } from "./visibility";
import { toLaunderingAction } from "./actions";

// =====================================================
// Care labels — DB-managed care-instruction lines for care-label-02.
// DB-managed via /settings/care-labels. The renderer loads the active set,
// filters by each style's wash-care symbols, and resolves per-language
// text from the Translation dictionary (sourceText is the lookup key).
// Cached in memory for a short TTL; admin writes bust it.
//
// Pure visibility logic (shared with the admin preview) lives in
// ./visibility — re-exported here so server callers have one import.
// =====================================================

export type { CareLabel, PresentSymbol } from "./visibility";
export {
  toSymbolCodeArray,
  isCareLabelVisible,
  explainCareLabelVisibility,
} from "./visibility";
export {
  LAUNDERING_ACTIONS,
  LAUNDERING_ACTION_LABELS,
  toLaunderingAction,
  type LaunderingAction,
} from "./actions";

const CACHE_TTL_MS = 30_000;
let cached: { at: number; labels: CareLabel[] } | null = null;

export async function loadCareLabels(): Promise<CareLabel[]> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.labels;

  const rows = await db.careLabel.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const labels: CareLabel[] = rows.map((r) => ({
    id: r.id,
    sourceText: r.sourceText,
    sortOrder: r.sortOrder,
    action: toLaunderingAction(r.action),
    showIfSymbols: toSymbolCodeArray(r.showIfSymbols),
    hideIfSymbols: toSymbolCodeArray(r.hideIfSymbols),
    active: r.active,
  }));
  cached = { at: Date.now(), labels };
  return labels;
}

// Bust the cache from the admin API after writes so the next render sees
// the change immediately rather than waiting out the TTL.
export function invalidateCareLabelCache(): void {
  cached = null;
}
