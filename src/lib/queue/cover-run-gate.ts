// Pure gates shared by the generation auto-paths — no db import, so the tests
// can pin them directly. The I/O around them lives in generation-sweep.ts.

// FAILED generation jobs for a style before the auto-paths give up and let it
// "float" for manual attention (mirrors the EAN 3-strike float). A successful
// render clears the gate naturally — a rendered output gets a non-FAILED asset
// and so drops out of pendingOutputKeysForStyle.
export const MAX_GEN_ATTEMPTS = 3;

// THE RULE: a style gets its cover page as soon as Monday's "Navision Task"
// (the PO number) has a value — for every customer, not only cover-only specs.
// The PO number is what turns a row into an order, and the cover is the
// supplier's manifest for that order, so it shouldn't wait for the first
// output to become ready. These gates only keep that rule from firing where a
// run can't succeed or isn't wanted.
export type CoverRunSkip =
  | "no_po"
  | "below_cutoff"
  | "no_prodspec"
  | "prodspec_inactive"
  | "no_outputs"
  | "auto_off"
  | "in_flight"
  | "floated"
  | "has_cover";

export type CoverRunFacts = {
  hasPo: boolean;
  // Below the generation PO cutoff (Settings → generation min PO). The
  // historical backlog stays parked — the same line the output sweep holds.
  belowCutoff: boolean;
  prodSpec: { active: boolean; coverOnly: boolean | null } | null;
  // ≥1 enabled output on the spec. Without one (and without cover-only) the
  // run would fail NO_OUTPUTS — that spec is misconfigured, not waiting.
  specHasOutputs: boolean;
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
  if (f.belowCutoff) return "below_cutoff";
  if (!f.prodSpec) return "no_prodspec";
  if (!f.prodSpec.active) return "prodspec_inactive";
  // Only a literal true counts as cover-only.
  const coverOnly = f.prodSpec.coverOnly === true;
  if (!coverOnly && !f.specHasOutputs) return "no_outputs";
  // The master switch governs output generation. A cover-only run produces the
  // cover and nothing else, so it isn't held back by it; any other spec's run
  // also renders whichever outputs are ready, so it is.
  if (!coverOnly && !f.autoGenerateEnabled) return "auto_off";
  if (f.inflight > 0) return "in_flight";
  if (f.recentFailures >= MAX_GEN_ATTEMPTS) return "floated";
  if (f.hasCover) return "has_cover";
  return null;
}
