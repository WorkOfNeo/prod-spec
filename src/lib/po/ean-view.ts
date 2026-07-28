import type { StyleEanStatus } from "@/generated/prisma/enums";
import type { PoScrapeSnapshot } from "./scrape-snapshot";

// Shared, UI-facing shape for a style's resolved EANs. Type-only module so it
// can be imported by both server code (runner, route, page) and the client
// table without pulling server deps into the client bundle. Everything speaks
// the persisted StyleEanStatus enum so the badge vocabulary is consistent
// whether the data came from the DB or a fresh re-resolve.
export type EanSize = {
  // Persisted StyleEan.id — the handle the override API toggles/deletes by.
  // Empty string only for rows synthesised outside the DB (e.g. a live scrape
  // preview that was never stored).
  id: string;
  size: string;
  ean13: string | null;
  variantLabel: string | null;
  // Carton EAN of the PO section this row came from (per colourway).
  cartonEan: string | null;
  // Manual override state (style-page EAN panel). `excluded` = hidden from all
  // rendering/tokens but kept for un-hiding; `manual` = hand-added row.
  excluded: boolean;
  manual: boolean;
};

// Map a persisted StyleEan row to the UI-facing EanSize. Pure (no server deps)
// so both the page loader and the re-resolve endpoint build the view the same
// way — including the manual/excluded flags the panel renders.
export function toEanSize(row: {
  id: string;
  size: string;
  ean13: string | null;
  variantLabel: string | null;
  cartonEan: string | null;
  excluded: boolean;
  manual: boolean;
}): EanSize {
  return {
    id: row.id,
    size: row.size,
    ean13: row.ean13,
    variantLabel: row.variantLabel,
    cartonEan: row.cartonEan,
    excluded: row.excluded,
    manual: row.manual,
  };
}

export type EanDiagnostics = {
  poNumber: string | null;
  poFileName: string | null;
  poFileId: string | null;
  /** How many PO PDFs matched the search. */
  candidateCount: number;
  /** Matching PDFs, best-first, with their score + SharePoint link. */
  candidates: Array<{ name: string; score: number; webUrl: string | null }>;
  queriesTried: string[];
  /** Direct SharePoint link to the chosen PO PDF — open it to verify. */
  poFileWebUrl: string | null;
  /** The supplier's SharePoint folder URL (Suppliers board), if linked. */
  supplierFolderUrl: string | null;
  /** Did the parser locate a "Barcodes" page in the chosen PDF? */
  barcodePageFound: boolean;
  pdfPageCount: number;
  pdfTextLength: number;
  /** Distinct 13-digit tokens anywhere in the PDF — a file-level "are there
   *  any barcodes at all" signal, independent of our page parser. */
  ean13TokensInFullText: number;
  parsedItemCount: number;
  parsedVariantCount: number;
  matchedByCustomerItemNo: boolean;
  /** Did we pick the PO section(s) by matching the style number? */
  matchedByStyleNumber: boolean;
  customerItemNoOnStyle: string | null;
  /** The style number we matched against (Style.name / styleNumber column). */
  styleNumberOnStyle: string | null;
  /** Distinct style numbers found across the PO's sections — the candidate
   *  set a STYLE_NOT_IN_PO reject was checked against. */
  poStyleNumbers: string[];
  /** The style's 🎨 Colour code column value, e.g. "*A" — the colourway
   *  marker used to scope a multi-colourway section's rows. */
  colourCodeOnStyle: string | null;
  /** PO colour letters parsed off the Colour code ("*A" → ["A"]). Empty when
   *  the column carries no starred letter (colour names etc.). */
  colourLetters: string[];
  /** True when the variants were scoped to the style's colour letter(s) —
   *  i.e. the Colour code has "*X" AND the PO rows are letter-marked. */
  colourScopeApplied: boolean;
  /** Variant rows dropped as other colourways' (0 when scoping not applied). */
  variantsExcludedByColour: number;
  /** Every section parsed from the PO's Barcodes page, each flagged with
   *  whether this resolve selected it (`selected`). Powers the "full scrape,
   *  green = used" panel. Still trimmed from the persisted Log payload (logs
   *  stay lean) — but no longer thrown away: a trimmed copy is stored on
   *  Style.poScrapeSnapshot, so the panel also renders on page load without a
   *  re-scrape. See src/lib/po/scrape-snapshot.ts. */
  poSections: Array<{
    styleNumber: string | null;
    contrastNo: string | null;
    selected: boolean;
    /** `used` = this row actually fed EAN-13 (per size); false on rows of a
     *  selected section that colour scoping excluded as another colourway's. */
    variants: Array<{ label: string; ean13: string; used: boolean }>;
    cartonEan: string | null;
  }>;
  styleSizes: string[];
  /** First ~600 chars of the Barcodes page (or whole doc) for eyeballing. */
  textSnippet: string;
};

export type EanView = {
  status: StyleEanStatus;
  message?: string;
  poFileName: string | null;
  sizeEans: EanSize[];
  cartonEan: string | null;
  /** Per-style colour source for repeat-per-EAN rendering: true = Style board
   *  colour, false/undefined = PO variant-label colour (the default). Powers
   *  the EAN panel's colour-source toggle. Optional so the many EanView
   *  constructors that don't need it can omit it (the panel treats absent as
   *  false). */
  useStyleBoardColour?: boolean;
  /** Present only for the duration of a live resolve — the whole struct is far
   *  too bulky (candidate list, PDF-text snippet) to keep per style, so it is
   *  never persisted. Lets the UI/API show exactly which file was read and
   *  whether it contained barcodes. Its poSections dump IS kept, trimmed, in
   *  `scrapeSnapshot` below. */
  diagnostics?: EanDiagnostics;
  /** The last scrape's section dump, read back from Style.poScrapeSnapshot.
   *  The PAGE-LOAD source for the scrape panel: `diagnostics` above only
   *  exists for the few hundred ms of a live resolve, so before this field a
   *  reader had to click Re-resolve (and re-scrape SharePoint) to see an
   *  answer the system had already computed. Live `diagnostics` still wins
   *  when present — it's fresher — and this fills in otherwise. Null/absent =
   *  never scraped, or scraped before the column existed. */
  scrapeSnapshot?: PoScrapeSnapshot | null;
};
