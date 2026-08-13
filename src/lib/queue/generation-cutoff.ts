// =====================================================
// The GENERATION PO cutoff (generationMinPo) as a predicate the bulk surfaces
// can show, not just a filter buried in one query.
//
// Until now the cutoff was enforced in exactly one place — the candidate query
// in generation-sweep.ts. That is by design: the setting's own contract is
// "park the automatic BACKLOG sweep", and an operator pressing Run is an
// explicit decision the cutoff was never meant to veto. The problem is not that
// the bulk buttons ignore it; it is that they ignore it INVISIBLY. On the
// Tokmanni Oy · License spec, "Run all (80)" reads like "run this spec" while
// 91 of its 109 styles sit below the cutoff, the oldest on PO 61278.
//
// That is the same shape as the mass supplier send of 2026-08-13: a bulk button
// whose blast radius was bigger than its label. So the bulk lanes now DEFAULT to
// the in-scope styles and say plainly how many they left behind, with an opt-in
// to include them. Nothing becomes impossible — the per-style Run button is
// untouched, one click, one style, exactly the deliberate act the cutoff should
// never block.
//
// NOTE the NULL rule, which is the OPPOSITE of the supplier-send cutoff's:
//
//   generation   poSeq NULL ⇒ IN scope. An unparseable PO means a PO that
//                didn't land on the numeric timeline, not a missing one, and a
//                ready output should still generate. This mirrors the sweep's
//                own `OR: [{ poSeq: { gte } }, { poSeq: null }]`.
//   supplier     poSeq NULL ⇒ NOT deliverable. Nothing that can't be placed on
//                the timeline should reach a supplier.
//
// The two rules genuinely differ, so they get two functions. Sharing one and
// papering over the difference with a flag is how a null-poSeq style quietly
// stops generating. Whether a style has a PO number AT ALL is a third, separate
// question — hasPoNumber / HAS_PO_NUMBER_WHERE in styles/active-filter.ts.
//
// PURE LEAF — no db import. Callers load the cutoff via getGenerationMinPo().
// =====================================================

// True when this style sits below the generation cutoff — i.e. parked backlog
// the automatic sweep would never pick up.
export function isBelowGenerationCutoff(poSeq: number | null | undefined, cutoff: number | null): boolean {
  if (cutoff === null) return false; // no cutoff configured — nothing is parked
  if (poSeq === null || poSeq === undefined) return false; // see the NULL rule above
  return poSeq < cutoff;
}

// The same rule as a Prisma `where` fragment, matching the sweep's clause
// exactly (poSeq at/above the cutoff, OR no parseable poSeq at all).
export function inGenerationScopeWhere(
  cutoff: number | null,
): { OR?: Array<{ poSeq: { gte: number } } | { poSeq: null }> } {
  return cutoff === null ? {} : { OR: [{ poSeq: { gte: cutoff } }, { poSeq: null }] };
}

// Split a set of rows into the ones a bulk action will run by default and the
// parked ones it will report. Used by every bulk lane so the count an operator
// reads and the set that actually runs are computed once, from one rule.
export function partitionByGenerationCutoff<T extends { poSeq?: number | null }>(
  rows: T[],
  cutoff: number | null,
): { inScope: T[]; belowCutoff: T[] } {
  const inScope: T[] = [];
  const belowCutoff: T[] = [];
  for (const row of rows) {
    if (isBelowGenerationCutoff(row.poSeq, cutoff)) belowCutoff.push(row);
    else inScope.push(row);
  }
  return { inScope, belowCutoff };
}
