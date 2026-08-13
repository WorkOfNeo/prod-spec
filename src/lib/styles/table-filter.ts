// Facet filtering for the /styles table.
//
// Extracted from styles-table.tsx so the *rules* (which row value a facet reads,
// how a blank collapses, how facets combine) are one testable place instead of
// a hand-written branch per facet inside a client component — adding "Reviewer"
// to a switch-style filter loop is exactly how a facet ends up in the dropdown
// bar but silently not filtering.
//
// Semantics, unchanged from the original loop: within a facet the selections are
// OR'd (Netto OR Coop); across facets they're AND'd (customer ∈ {…} AND reviewer
// ∈ {…}).

import { BLANK_BA_VALUES } from "@/lib/import/heuristics";

// Sentinel so blank / "–" business areas, null groups and unclaimed reviews
// collapse into ONE selectable option instead of vanishing from the dropdown.
// Plain ASCII on purpose (a control-char sentinel makes git treat the file as
// binary).
export const BLANK_VALUE = "__blank__";

export type FacetKey = "customer" | "ba" | "group" | "status" | "reviewer" | "ean";

// Render / serialisation order for the filter bar and the query string.
export const FACET_KEYS: readonly FacetKey[] = [
  "customer",
  "ba",
  "group",
  "status",
  "reviewer",
  "ean",
];

export const EMPTY_FACETS: Record<FacetKey, string[]> = {
  customer: [],
  ba: [],
  group: [],
  status: [],
  reviewer: [],
  ean: [],
};

// The row shape the facets read — structural, so the table's much larger
// StyleRow satisfies it without this module importing a client component.
export type FacetableRow = {
  // The CLIENT the style belongs to (Netto, Coop, …). Called "customer"
  // everywhere in the schema; "client" is the same thing in reviewer-speak.
  customerName: string;
  businessArea: string | null;
  groupTitle: string | null;
  statusView: { key: string };
  eanStatus: string;
  // Who is reviewing: the reviewer who claimed this style's newest claimed job
  // (Job.reviewClaimedBy). Null = nobody has taken it yet.
  reviewerName: string | null;
};

export function customerValue(r: FacetableRow): string {
  return r.customerName.trim() || BLANK_VALUE;
}

export function baValue(r: FacetableRow): string {
  const v = r.businessArea;
  if (v == null) return BLANK_VALUE;
  const t = v.trim();
  return BLANK_BA_VALUES.has(t) ? BLANK_VALUE : t;
}

export function groupValue(r: FacetableRow): string {
  const t = r.groupTitle?.trim();
  return t ? t : BLANK_VALUE;
}

// Unclaimed reviews collapse to the blank sentinel, which the filter bar labels
// "(nobody yet)" — that IS the useful selection ("what has nobody picked up?"),
// so it must be pickable rather than dropped.
export function reviewerValue(r: FacetableRow): string {
  const t = r.reviewerName?.trim();
  return t ? t : BLANK_VALUE;
}

// One value-reader per facet. Adding a facet here (plus its dropdown) is the
// whole change — matchesFacets iterates this map, so a new facet can't be
// forgotten in the filter loop.
export const FACET_VALUE: Record<FacetKey, (r: FacetableRow) => string> = {
  customer: customerValue,
  ba: baValue,
  group: groupValue,
  status: (r) => r.statusView.key,
  reviewer: reviewerValue,
  ean: (r) => r.eanStatus,
};

// Pre-builds one Set per ACTIVE facet and returns a row predicate, so the
// ~4k-row filter pass stays membership-only (the shape the table had before
// this module existed).
export function buildFacetMatcher(
  applied: Record<FacetKey, string[]>,
): (row: FacetableRow) => boolean {
  const active: Array<[(r: FacetableRow) => string, Set<string>]> = [];
  for (const key of FACET_KEYS) {
    const values = applied[key];
    if (values && values.length > 0) active.push([FACET_VALUE[key], new Set(values)]);
  }
  if (active.length === 0) return () => true;
  return (row) => {
    for (const [read, set] of active) if (!set.has(read(row))) return false;
    return true;
  };
}

// Convenience wrapper — same rules, one row at a time (tests, one-offs).
export function matchesFacets(row: FacetableRow, applied: Record<FacetKey, string[]>): boolean {
  return buildFacetMatcher(applied)(row);
}

// Two string[]s as unordered sets — drives the Apply button's dirty state.
export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((v) => s.has(v));
}
