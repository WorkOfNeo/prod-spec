import { db } from "@/lib/db";
import { LAYOUT_VARIANT_PREFIX, layoutIdFromVariantKey } from "./variants";

// =====================================================
// Generation statistics for Output Builder layouts. Every PDF a layout
// produces is a JobAsset whose variantKey is `layout:<id>` (single-file) or
// `layout:<id>#<suffix>` (per-EAN split), so "how many times was this output
// generated" is a count over those rows. The Settings tab shows the detailed
// per-layout breakdown; the list page shows the compact totals.
// =====================================================

export type LayoutGenerationStats = {
  // Every JobAsset this layout has ever produced (incl. per-EAN split files).
  total: number;
  approved: number;
  pendingReview: number;
  rejected: number;
  // Distinct styles the layout has been generated for.
  distinctStyles: number;
  // Most recent generation, ISO string, or null if never generated.
  lastGeneratedAt: string | null;
};

// Match both the single-file key and the per-EAN `#suffix` keys for one
// layout, without prefix-colliding onto a different id that merely starts
// the same (cuid lengths differ, but `#` boundary makes this exact).
function whereForLayout(layoutId: string) {
  return {
    OR: [
      { variantKey: `${LAYOUT_VARIANT_PREFIX}${layoutId}` },
      { variantKey: { startsWith: `${LAYOUT_VARIANT_PREFIX}${layoutId}#` } },
    ],
  };
}

export async function generationStatsForLayout(layoutId: string): Promise<LayoutGenerationStats> {
  // One pass over this layout's assets — bounded by its generation history,
  // so a single findMany is cheaper than several aggregate round-trips.
  const assets = await db.jobAsset.findMany({
    where: whereForLayout(layoutId),
    select: { reviewStatus: true, createdAt: true, job: { select: { styleId: true } } },
  });

  const styles = new Set<string>();
  let approved = 0;
  let pendingReview = 0;
  let rejected = 0;
  let lastGeneratedAt: Date | null = null;
  for (const a of assets) {
    if (a.reviewStatus === "APPROVED") approved++;
    else if (a.reviewStatus === "REJECTED") rejected++;
    else pendingReview++;
    if (a.job.styleId) styles.add(a.job.styleId);
    if (!lastGeneratedAt || a.createdAt > lastGeneratedAt) lastGeneratedAt = a.createdAt;
  }

  return {
    total: assets.length,
    approved,
    pendingReview,
    rejected,
    distinctStyles: styles.size,
    lastGeneratedAt: lastGeneratedAt ? lastGeneratedAt.toISOString() : null,
  };
}

export type LayoutGenerationCount = { total: number; lastGeneratedAt: string | null };

// Compact totals for EVERY layout in ONE grouped query — the list page
// renders a card per layout and must not fan out to N stat queries. Keyed
// by OutputLayout id (suffixes folded into their base id).
export async function generationCountsByLayout(): Promise<Map<string, LayoutGenerationCount>> {
  const grouped = await db.jobAsset.groupBy({
    by: ["variantKey"],
    where: { variantKey: { startsWith: LAYOUT_VARIANT_PREFIX } },
    _count: { _all: true },
    _max: { createdAt: true },
  });

  const out = new Map<string, LayoutGenerationCount>();
  for (const g of grouped) {
    const layoutId = layoutIdFromVariantKey(g.variantKey);
    if (!layoutId) continue;
    const prev = out.get(layoutId);
    const max = g._max.createdAt ? g._max.createdAt.toISOString() : null;
    out.set(layoutId, {
      total: (prev?.total ?? 0) + g._count._all,
      lastGeneratedAt:
        !prev || !prev.lastGeneratedAt || (max && max > prev.lastGeneratedAt)
          ? (max ?? prev?.lastGeneratedAt ?? null)
          : prev.lastGeneratedAt,
    });
  }
  return out;
}
