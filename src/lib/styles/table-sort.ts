// Default row order for the /styles table: newest PURCHASE ORDER first.
//
// Why not just sort the PO string: poNumber is customer-prefixed free text
// ("C-PO9", "C-PO12345", "PO-12345/2"), so a lexicographic sort puts C-PO9
// ABOVE C-PO12345 — the oldest order at the top of a reviewer's list. The
// numeric part is already parsed at ingest into Style.poSeq (see
// monday/ingest.ts → parsePoNumberValue), which is the same number the
// automation cutoffs compare against, so ordering on it keeps the list and the
// cutoffs telling the same story about which PO is "later".
//
// Rows with no poSeq (no PO number yet, or an unparseable one) sort LAST,
// regardless of direction — they are not on the PO timeline at all. Ties fall
// back to the most recently updated row so the order is total and stable.

export type PoSortableRow = {
  poSeq: number | null;
  // Optional tiebreak for rows on the same PO. When it's absent (the table
  // ships formatted dates, not ISO ones, to keep the ~4k-row payload small)
  // ties keep their input order — Array#sort is stable, and the server already
  // ordered by poSeq desc, updatedAt desc, so the result is the same.
  updatedAtIso?: string | null;
};

// Descending by parsed PO number, nulls last, updatedAt desc as the tiebreak.
export function comparePoDesc(a: PoSortableRow, b: PoSortableRow): number {
  const as = a.poSeq;
  const bs = b.poSeq;
  if (as == null && bs == null) return compareUpdatedDesc(a, b);
  // Nulls sink to the bottom (they'd otherwise ride at the top of a DESC sort
  // in Postgres, which is exactly the "why is this junk first?" complaint).
  if (as == null) return 1;
  if (bs == null) return -1;
  if (as !== bs) return bs - as;
  return compareUpdatedDesc(a, b);
}

function compareUpdatedDesc(a: PoSortableRow, b: PoSortableRow): number {
  const au = a.updatedAtIso;
  const bu = b.updatedAtIso;
  if (!au || !bu || au === bu) return 0;
  return au < bu ? 1 : -1;
}

// Non-mutating sort — the caller's array (React props) is never reordered
// in place.
export function sortByPoDesc<T extends PoSortableRow>(rows: readonly T[]): T[] {
  return [...rows].sort(comparePoDesc);
}
