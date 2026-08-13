// "Back" from a style page has to land where the reviewer CAME FROM.
//
// The complaint: a reviewer searches a PO in /styles, opens one of its styles,
// reviews it, hits Back — and lands on the unfiltered table, so the same PO has
// to be searched again for the next style on that order.
//
// Two halves:
//   1. The styles table stashes its serialised filter (the same query string it
//      already writes to the address bar) under STYLES_FILTER_KEY in
//      sessionStorage.
//   2. The style page's back link replays it — and when there is nothing
//      stashed (deep link, new tab, fresh session) it falls back to the style's
//      OWN PO number as the search, so Back still lands on that PO rather than
//      on all ~4k rows.
//
// sessionStorage rather than a ?from= parameter: the filter is a browsing
// position, not part of the style's identity, and stuffing an encoded query
// string into every row link would leak into shared/bookmarked style URLs.

export const STYLES_FILTER_KEY = "prodspec:styles:filter";

// Keys serializeFilters() can emit. A stashed value that carries anything else
// is treated as junk (stale format, another app on the same origin, a tampered
// value) and ignored — the link falls back rather than building a URL out of
// unknown parameters.
const ALLOWED_PARAMS = new Set([
  "q",
  "customer",
  "ba",
  "group",
  "status",
  "reviewer",
  "ean",
  "with",
  "without",
  "archived",
]);

export function isKnownStylesFilter(qs: string): boolean {
  if (!qs) return false;
  // Length cap: a sane filter is short; anything huge is not ours.
  if (qs.length > 2000) return false;
  try {
    const params = new URLSearchParams(qs);
    let any = false;
    for (const key of params.keys()) {
      if (!ALLOWED_PARAMS.has(key)) return false;
      any = true;
    }
    return any;
  } catch {
    return false;
  }
}

// The href for the style page's back link.
//  • a valid stashed filter  → /styles?<that filter>
//  • else a PO number        → /styles?q=<po>   (lands on that PO's rows)
//  • else                    → /styles
export function stylesBackHref(stashed: string | null, poNumber: string | null): string {
  const qs = (stashed ?? "").replace(/^\?/, "");
  if (isKnownStylesFilter(qs)) return `/styles?${qs}`;
  const po = poNumber?.trim();
  if (po) return `/styles?q=${encodeURIComponent(po)}`;
  return "/styles";
}

// Label for that link. It names the PO whenever the destination is scoped to
// one, so the reviewer can see where Back goes before clicking it.
export function stylesBackLabel(stashed: string | null, poNumber: string | null): string {
  const qs = (stashed ?? "").replace(/^\?/, "");
  const po = poNumber?.trim();
  if (isKnownStylesFilter(qs)) {
    const q = new URLSearchParams(qs).get("q")?.trim();
    // The reviewer's own search wins the label when it IS this style's PO (the
    // common "searched the PO, opened a row" path).
    if (q && po && poMatchesSearch(q, po)) return `Back to PO ${po}`;
    if (q) return `Back to “${q}”`;
    return "Back to filtered styles";
  }
  if (po) return `Back to PO ${po}`;
  return "All styles";
}

// The table matches its search case-insensitively against a blob that contains
// the PO number, so "12345" and "c-po12345" both mean this style's PO.
function poMatchesSearch(search: string, poNumber: string): boolean {
  const s = search.toLowerCase();
  const po = poNumber.toLowerCase();
  return po.includes(s) || s.includes(po);
}
