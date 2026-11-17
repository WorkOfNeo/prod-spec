// How the runner settles a FULL run that rendered nothing. PURE LEAF — no
// imports, so the decision can be unit-tested without the runner's DB chain.
//
// Two clean endings exist, and they differ in one thing that matters: whether
// the cover is rebuilt.
//
//   "needs-none"     — every declared output is skipped for this style (a
//                      keyword rule or a reviewer's Ignore) and NONE is
//                      approved. The style needs no documents: settle APPROVED
//                      with no assets and no cover.
//   "fully-approved" — at least one output is approved and carried forward,
//                      and everything else is either approved too or skipped
//                      for this style. Settle APPROVED and REBUILD the cover,
//                      so its manifest reflects today's set.
//
// THE BUG THIS SHAPE FIXES (diagnosed 2026-11-17 on a Netto DE socks style).
// The runner drops approved outputs from its render list BEFORE the loop that
// applies rules and ignores. So "approved + the rest ignored" reached the loop
// with only the ignored ones left, every one of them was skipped, and the
// "needs-none" ending fired — which returns before the cover step. The cover
// kept listing the output the reviewer had just ignored, through any number of
// re-runs. "fully-approved" used to require zero skipped outputs, so this case
// could never reach the ending that rebuilds the cover.
//
// Anything else returns null and falls through to the runner's existing paths:
// a scoped run, a run with outputs still waiting on Monday fields (they must
// keep surfacing as "awaiting data", so they never settle APPROVED here), or a
// genuine misconfiguration (NO_OUTPUTS).

export type EmptyFullRunEnding = "needs-none" | "fully-approved";

export function settleEmptyFullRun(c: {
  generated: number;
  scoped: number;
  approvedSkips: number;
  missingFieldSkips: number;
  // Outputs that reached the render loop and were skipped there (keyword rule
  // or reviewer Ignore), and how many reached the loop at all.
  skippedForStyle: number;
  reachedLoop: number;
}): EmptyFullRunEnding | null {
  if (c.generated > 0 || c.scoped > 0 || c.missingFieldSkips > 0) return null;
  if (c.approvedSkips > 0) return "fully-approved";
  if (c.skippedForStyle > 0 && c.skippedForStyle === c.reachedLoop) return "needs-none";
  return null;
}
