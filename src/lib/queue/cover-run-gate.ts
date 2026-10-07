// Pure gates shared by the generation auto-paths — no db import, so the tests
// can pin them directly. The I/O around them lives in generation-sweep.ts.

// FAILED generation jobs for a style before the auto-paths give up and let it
// "float" for manual attention (mirrors the EAN 3-strike float). A successful
// render clears the gate naturally — a rendered output gets a non-FAILED asset
// and so drops out of pendingOutputKeysForStyle.
export const MAX_GEN_ATTEMPTS = 3;

export type CoverRunSkip =
  | "no_po"
  | "no_prodspec"
  | "prodspec_inactive"
  | "not_cover_only"
  | "auto_off"
  | "in_flight"
  | "floated"
  | "has_cover";

export type CoverRunFacts = {
  hasPo: boolean;
  prodSpec: { active: boolean; coverOnly: boolean | null } | null;
  // Only cover-only specs qualify (the sweep / ingest paths). Off for the
  // cover-regen drain, where a human just changed the style's packaging.
  requireCoverOnly: boolean;
  autoGenerateEnabled: boolean;
  inflight: number;
  // FAILED jobs since the spec was last edited — ticking cover-only (or any
  // fix to the spec) is a fresh start, so old NO_OUTPUTS failures don't count.
  recentFailures: number;
  hasCover: boolean;
};

// Pure decision, cheapest-first; the first failing gate wins. null ⇒ enqueue.
export function decideCoverRun(f: CoverRunFacts): CoverRunSkip | null {
  if (!f.hasPo) return "no_po";
  if (!f.prodSpec) return "no_prodspec";
  if (!f.prodSpec.active) return "prodspec_inactive";
  // Only a literal true counts as cover-only.
  const coverOnly = f.prodSpec.coverOnly === true;
  if (f.requireCoverOnly && !coverOnly) return "not_cover_only";
  // The master switch governs output generation. A cover-only run produces the
  // cover and nothing else, so it isn't held back by it; any other spec's run
  // would render its ready outputs too, so it is.
  if (!coverOnly && !f.autoGenerateEnabled) return "auto_off";
  if (f.inflight > 0) return "in_flight";
  if (f.recentFailures >= MAX_GEN_ATTEMPTS) return "floated";
  if (f.hasCover) return "has_cover";
  return null;
}
