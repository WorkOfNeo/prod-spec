// Resolving the style number a person TYPED to exactly one style row.
//
// Deliberately NO imports (no DB, no render chain) so it is trivially unit
// testable — the same shape as cover-regen-ledger.ts. The caller does the
// query; this decides what the result means.
//
// WHY THIS IS NOT THE SAME AS THE SAMPLE-PDF LOOKUP. The cover sample endpoint
// resolves a typed style number with "exact, else contains, else newest wins"
// and that is fine there: it renders bytes, hands them back and forgets them.
// This module backs a WRITE — it picks the style whose cover gets rebuilt and
// re-uploaded into a supplier's folder, overwriting the PDF they are looking at
// today. Silently picking the most recently updated row out of several is
// exactly the wrong behaviour for that: in this data a style NUMBER is not
// unique. Monday carries the same style name on one Pre-Order row per PO, and
// two colourways of one style share the number and differ only by colour code.
// So several matches is the NORMAL case, not a rare edge, and the only honest
// answer is to hand them all back and let the person say which one they meant.
//
// The two rules, in order:
//
//   1. An exact name match wins outright. A precise entry must never be beaten
//      — or joined — by a longer row that merely contains it, or typing a short
//      style number would drag in every style whose number extends it.
//   2. Only when nothing matches exactly do we fall back to `contains`, so a
//      half-remembered number still finds something rather than dead-ending.
//
// Either tier can return several rows; both report that as `ambiguous` rather
// than choosing.

// The minimum a caller must select. Extra fields ride along untouched (the
// generic), so the route can carry customer / supplier / PO for the picker
// without this module knowing about them.
export type StyleNameRow = { id: string; name: string };

export type StyleNumberMatch<T extends StyleNameRow> =
  // Nothing matched, exactly or partially.
  | { kind: "none" }
  // Exactly one row — safe to act on without asking.
  | { kind: "one"; row: T; matchedExactly: boolean }
  // Several rows matched at the same tier. NEVER resolved here: the caller must
  // put the choice to a human, because every candidate is a different order.
  | { kind: "ambiguous"; rows: T[]; matchedExactly: boolean };

// Normalised for comparison: people paste style numbers with stray whitespace
// and inconsistent case ("il63378 " for IL63378).
function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function pickStyleNumberMatch<T extends StyleNameRow>(
  rows: readonly T[],
  query: string,
): StyleNumberMatch<T> {
  const q = norm(query);
  if (q.length === 0) return { kind: "none" };

  const exact = rows.filter((r) => norm(r.name) === q);
  if (exact.length > 0) return classify(exact, true);

  const partial = rows.filter((r) => norm(r.name).includes(q));
  if (partial.length > 0) return classify(partial, false);

  return { kind: "none" };
}

function classify<T extends StyleNameRow>(rows: T[], matchedExactly: boolean): StyleNumberMatch<T> {
  return rows.length === 1
    ? { kind: "one", row: rows[0]!, matchedExactly }
    : { kind: "ambiguous", rows, matchedExactly };
}
