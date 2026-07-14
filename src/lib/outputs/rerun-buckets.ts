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
};

export type OutputBucket = "missing" | "rejected" | "changed" | "ok";

// "changed" requires BOTH a stored key and a current key to compare — a null on
// either side (pre-deploy, un-backfilled, or an output missing from the spec)
// reads as "ok" so we never blast work on unknowns. APPROVED (generated, not
// rejected, no pending doc) is always "ok" — approved PDFs are never re-run,
// even when their config changed.
export function classifyOutput(st: BaseAssetState | undefined, currentKey: string | null): OutputBucket {
  if (!st || !st.hasAsset) return "missing";
  if (st.hasRejected) return "rejected";
  if (st.hasPending && st.configKey != null && currentKey != null && st.configKey !== currentKey) {
    return "changed";
  }
  return "ok";
}
