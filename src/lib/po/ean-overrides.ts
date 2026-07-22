// =====================================================
// Manual EAN override reconcile (style-page EAN panel).
//
// The scrape replaces style_eans wholesale on every re-resolve. For a manual
// override to be a real safety valve it MUST survive that — so before the
// runner rewrites the rows, it folds the previous rows' overrides back into the
// fresh scrape here:
//   • `excluded` (a hidden row) is carried onto the fresh scrape row with the
//     same size + EAN, so a de-selected barcode stays hidden after re-resolve.
//   • `manual` (a hand-added row) is preserved unless the scrape now provides
//     the same size + EAN itself (in which case it becomes a normal scrape row).
//
// Pure over plain objects so it's unit-testable without a DB. The caller
// assigns `position` by array index when persisting (print order = array order:
// scrape rows first, surviving manual rows appended).
// =====================================================

export type EanRow = {
  size: string;
  ean13: string | null;
  variantLabel: string | null;
  cartonEan: string | null;
  excluded: boolean;
  manual: boolean;
};

export type ScrapeRow = Omit<EanRow, "excluded" | "manual">;

// Identity of a barcode row for override matching: size + EAN. Position is
// deliberately NOT part of the key — the scrape can reorder/renumber freely and
// an override must still find its row. Size is normalised (trim/case) so a
// cosmetic label change ("M" vs "m ") doesn't drop the override.
export function eanRowKey(size: string, ean13: string | null): string {
  return `${size.trim().toLowerCase()}|${(ean13 ?? "").trim()}`;
}

export function reconcileEans(prev: EanRow[], scrape: ScrapeRow[]): EanRow[] {
  const excludedKeys = new Set(
    prev.filter((r) => r.excluded && !r.manual).map((r) => eanRowKey(r.size, r.ean13)),
  );
  const scrapeKeys = new Set(scrape.map((r) => eanRowKey(r.size, r.ean13)));

  const merged: EanRow[] = scrape.map((r) => ({
    ...r,
    manual: false,
    excluded: excludedKeys.has(eanRowKey(r.size, r.ean13)),
  }));

  // Keep hand-added rows the scrape doesn't already cover (carry their own
  // excluded flag). A manual row the scrape now yields on its own is dropped as
  // manual — the scrape row (above) represents it.
  for (const r of prev) {
    if (!r.manual) continue;
    if (scrapeKeys.has(eanRowKey(r.size, r.ean13))) continue;
    merged.push({ ...r });
  }
  return merged;
}
