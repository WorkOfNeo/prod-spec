// =====================================================
// Pure rerun-bucket decision — kept out of prod-spec-rerun.ts (which imports
// the db client) so it's unit-testable without a DATABASE_URL. Given the latest
// asset state of one output on one style plus that output's CURRENT config
// fingerprint, decide which rerun bucket the output falls into.
// =====================================================

// The latest asset facts for one output (base variantKey) on one style, rolled
// up from the per-document assets.
export type BaseAssetState = {
  hasAsset: boolean;
  hasRejected: boolean;
  // ≥1 latest doc still PENDING_REVIEW (base isn't fully approved).
  hasPending: boolean;
  // The output-config fingerprint the base was rendered with (null when the
  // column is pre-db:deploy / the asset predates the feature / no backfill yet).
  configKey: string | null;
  // The Output Builder layout version the base rendered from (null for coded
  // variants and legacy rows).
  contentVersion: number | null;
};

export type OutputBucket = "missing" | "rejected" | "changed" | "pending" | "ok";

// Every not-approved output is re-runnable — "Run all" runs new/missing,
// rejected, AND everything still awaiting review. The ONLY skip is "ok" =
// APPROVED (generated, not rejected, no pending doc): approved PDFs are never
// re-run, even when their config changed.
//
// Among the awaiting-review outputs we still distinguish "changed" — edited
// since it rendered — from a plain "pending" re-run. "changed" covers BOTH the
// row config (configKey mismatch) AND the layout content (its published version
// bumped). Both run; it's a display highlight. A null on either side of either
// comparison can't be evaluated, so it reads as plain "pending", not "changed".
export function classifyOutput(
  st: BaseAssetState | undefined,
  currentKey: string | null,
  currentContentVersion: number | null,
): OutputBucket {
  if (!st || !st.hasAsset) return "missing";
  if (st.hasRejected) return "rejected";
  if (st.hasPending) {
    const configChanged = st.configKey != null && currentKey != null && st.configKey !== currentKey;
    const contentChanged =
      st.contentVersion != null &&
      currentContentVersion != null &&
      st.contentVersion !== currentContentVersion;
    return configChanged || contentChanged ? "changed" : "pending";
  }
  return "ok";
}
