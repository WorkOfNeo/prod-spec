import { z } from "zod";
import type { EanDiagnostics } from "./ean-view";

// =====================================================
// "What did this PO actually contain?" — persisted.
//
// EanDiagnostics.poSections is a full per-section dump of the PO's Barcodes
// page: every section, its style number, its carton EAN, each variant label +
// EAN, and whether THIS style's resolve used it. It is built on every scrape
// and, until this module existed, immediately thrown away — the runner strips
// it before the Log write (logs stay lean) and nothing else stored it.
//
// That dump is the answer to the single most common "something's up with this
// style" report. Real case: a reviewer expected more sizes than the PDFs
// showed; the truth was that the Purchase Order for THIS Monday row only
// carried two size groups (27-30, 31-34) and the rest lived on a DIFFERENT row
// under a different PO. The system computed that answer, held it for a few
// hundred ms inside a background job, and dropped it. Seeing it again meant
// clicking Re-resolve and re-scraping SharePoint for something we already had.
//
// So we trim the dump into a small, versioned, JSON-safe shape and store it on
// Style.poScrapeSnapshot (JSONB) for the style page to render on load. Small is
// a hard requirement — this lands on EVERY style row — so the bulky diagnostics
// (textSnippet, the ranked candidate list, the raw PDF stats) are dropped and
// both the section list and each section's variant list are capped.
// =====================================================

// Bump ONLY together with a shape change. parsePoScrapeSnapshot refuses any
// other version outright rather than guessing: a snapshot written by a newer
// deploy must render as "nothing stored yet" (and be replaced by the next
// resolve), never be half-read into a shape it isn't.
export const PO_SCRAPE_SNAPSHOT_VERSION = 1;

// Storage caps. A normal Contrast PO carries ~10 sections of ~5 sizes; these
// are ~8x headroom, sized to bound the worst case (a jumbo consolidated PO)
// rather than to trim the normal one. Hitting either sets `truncated`, which
// the panel surfaces so a capped dump never reads as the whole PO.
export const MAX_SNAPSHOT_SECTIONS = 80;
export const MAX_SNAPSHOT_VARIANTS_PER_SECTION = 80;

// One section of the PO's Barcodes page. Deliberately spelled out rather than
// aliased off EanDiagnostics: this is an on-disk contract that must stay
// readable by future deploys, so it should only change when the version does.
// Structurally identical to EanDiagnostics["poSections"][number] on purpose —
// that is what lets ScrapePanel render the live and the stored dump with one
// component (tsc catches the drift at the call site if the two ever diverge).
export type PoScrapeSection = {
  styleNumber: string | null;
  contrastNo: string | null;
  /** Did this style's resolve select this section? (the "green = used" flag) */
  selected: boolean;
  cartonEan: string | null;
  /** `used` = this row actually fed EAN-13 (per size); false on rows of a
   *  selected section that colour scoping excluded as another colourway's. */
  variants: Array<{ label: string; ean13: string; used: boolean }>;
};

export type PoScrapeSnapshot = {
  version: typeof PO_SCRAPE_SNAPSHOT_VERSION;
  /** ISO timestamp of the scrape this dump came from. Null only for a legacy
   *  row that stored no timestamp AND whose caller passed no fallback — see
   *  the `fallbackScrapedAt` argument of parsePoScrapeSnapshot. */
  scrapedAt: string | null;
  poFileName: string | null;
  /** Direct SharePoint link to the PO PDF, so "check it yourself" is one click
   *  from the stored dump — without it a stale snapshot is unverifiable. */
  poFileWebUrl: string | null;
  sections: PoScrapeSection[];
  /** How many sections the PO really had, before MAX_SNAPSHOT_SECTIONS. */
  sectionCount: number;
  /** True when sections and/or variants were cut to fit the caps. */
  truncated: boolean;
  /** The style's size run as the scrape read it (splitSizes(readCol(...)) via
   *  eanResolveInputs) — the "expected" half of the size-coverage line. */
  styleSizes: string[];
  // ---- match context: WHY these sections were the selected ones ----
  matchedByCustomerItemNo: boolean;
  matchedByStyleNumber: boolean;
  /** Every style number the PO listed — the candidate set a STYLE_NOT_IN_PO
   *  reject was checked against ("it lists X, Y, Z — but not yours"). */
  poStyleNumbers: string[];
  colourCodeOnStyle: string | null;
  colourLetters: string[];
  colourScopeApplied: boolean;
  variantsExcludedByColour: number;
};

// Trim a live EanDiagnostics down to the persisted snapshot. `scrapedAt` is an
// argument (not `new Date()` inline) so the runner can stamp it with the same
// instant it writes Style.eanResolvedAt, and so tests are deterministic.
export function buildPoScrapeSnapshot(
  d: EanDiagnostics,
  scrapedAt: Date = new Date(),
): PoScrapeSnapshot {
  // Cap selected-first. On a jumbo consolidated PO the section this style
  // matched can sit past the cap, and dropping THAT one would throw away the
  // single row the panel exists to show. ScrapePanel already renders
  // selected-first, so reordering here costs nothing visually.
  const ordered = [
    ...d.poSections.filter((s) => s.selected),
    ...d.poSections.filter((s) => !s.selected),
  ];
  const kept = ordered.slice(0, MAX_SNAPSHOT_SECTIONS);
  const sections: PoScrapeSection[] = kept.map((s) => ({
    styleNumber: s.styleNumber,
    contrastNo: s.contrastNo,
    selected: s.selected,
    cartonEan: s.cartonEan,
    variants: s.variants.slice(0, MAX_SNAPSHOT_VARIANTS_PER_SECTION).map((v) => ({
      label: v.label,
      ean13: v.ean13,
      used: v.used,
    })),
  }));

  return {
    version: PO_SCRAPE_SNAPSHOT_VERSION,
    scrapedAt: scrapedAt.toISOString(),
    poFileName: d.poFileName,
    poFileWebUrl: d.poFileWebUrl,
    sections,
    sectionCount: d.poSections.length,
    truncated:
      d.poSections.length > MAX_SNAPSHOT_SECTIONS ||
      d.poSections.some((s) => s.variants.length > MAX_SNAPSHOT_VARIANTS_PER_SECTION),
    styleSizes: d.styleSizes,
    matchedByCustomerItemNo: d.matchedByCustomerItemNo,
    matchedByStyleNumber: d.matchedByStyleNumber,
    poStyleNumbers: d.poStyleNumbers,
    colourCodeOnStyle: d.colourCodeOnStyle,
    colourLetters: d.colourLetters,
    colourScopeApplied: d.colourScopeApplied,
    variantsExcludedByColour: d.variantsExcludedByColour,
  };
}

// Per-FIELD `.catch()` throughout, not just a top-level safeParse: the input is
// a JSONB column that has been written by every deploy since the feature
// shipped, so one field going missing (or arriving as the wrong type) must
// degrade that field only — losing the whole "why does this style look like
// this" panel over a stray null is exactly the failure this module exists to
// prevent. `version` is the one field deliberately NOT caught (see the const).
const VariantSchema = z.object({
  label: z.string().catch(""),
  ean13: z.string().catch(""),
  used: z.boolean().catch(false),
});

const SectionSchema = z.object({
  styleNumber: z.string().nullable().catch(null),
  contrastNo: z.string().nullable().catch(null),
  selected: z.boolean().catch(false),
  cartonEan: z.string().nullable().catch(null),
  variants: z.array(VariantSchema).catch([]),
});

const SnapshotSchema = z.object({
  version: z.literal(PO_SCRAPE_SNAPSHOT_VERSION),
  scrapedAt: z.string().nullable().catch(null),
  poFileName: z.string().nullable().catch(null),
  poFileWebUrl: z.string().nullable().catch(null),
  sections: z.array(SectionSchema).catch([]),
  sectionCount: z.number().catch(0),
  truncated: z.boolean().catch(false),
  styleSizes: z.array(z.string()).catch([]),
  matchedByCustomerItemNo: z.boolean().catch(false),
  matchedByStyleNumber: z.boolean().catch(false),
  poStyleNumbers: z.array(z.string()).catch([]),
  colourCodeOnStyle: z.string().nullable().catch(null),
  colourLetters: z.array(z.string()).catch([]),
  colourScopeApplied: z.boolean().catch(false),
  variantsExcludedByColour: z.number().catch(0),
});

// Read Style.poScrapeSnapshot back. NEVER throws: a legacy row, a hand-edited
// JSONB value or a future version returns null and the page simply renders
// nothing rather than 500ing on a diagnostics panel.
//
// `fallbackScrapedAt` covers the rows written before this column carried its
// own timestamp — pass Style.eanResolvedAt so the provenance header can still
// say WHEN, which is the whole point of showing stored data at all.
export function parsePoScrapeSnapshot(
  json: unknown,
  fallbackScrapedAt?: Date | string | null,
): PoScrapeSnapshot | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  try {
    const res = SnapshotSchema.safeParse(json);
    if (!res.success) return null;
    const s = res.data;
    return {
      ...s,
      scrapedAt: s.scrapedAt ?? toIsoOrNull(fallbackScrapedAt),
      // A pre-`sectionCount` (or corrupted) row still knows how many sections
      // it actually carries — never report 0 sections next to a section list.
      sectionCount: s.sectionCount > 0 ? s.sectionCount : s.sections.length,
    };
  } catch {
    // safeParse shouldn't throw, but this is the "never blow up the style page"
    // boundary — a zod upgrade changing that must not take the page with it.
    return null;
  }
}

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// =====================================================
// Size coverage — expectation vs reality, in one sentence.
//
// "Board lists 4 sizes · this PO covers 2 (27-30, 31-34) · 2 with no barcode
// in this PO". The panel used to show only the resolved rows, which answers
// "what did we get" but never "is that all there should be" — and the gap
// between those two is precisely what people open a support ticket about.
// Kept pure (and out of the JSX) so the wording is testable.
// =====================================================

// The subset of a resolved EAN row this computation needs — structurally a
// subset of EanSize, so the panel can pass view.sizeEans straight in.
export type SizeCoverageRow = {
  size: string;
  ean13: string | null;
  excluded: boolean;
  manual: boolean;
};

export type SizeCoverage = {
  /** The style's size run, de-duplicated, in board order. */
  boardSizes: string[];
  /** Board sizes carrying a live barcode scraped from this PO. */
  fromPo: string[];
  /** Board sizes whose only live barcode was added by hand (NOT from the PO —
   *  counting these as PO coverage would re-hide the very gap we're naming). */
  manual: string[];
  /** Board sizes with no live barcode at all — the "missing" half. */
  missing: string[];
  /** Live rows for a size that isn't on the board's size run at all. */
  extra: string[];
  /** True when every board size has a barcode (from the PO or by hand). */
  complete: boolean;
  /** The sentence, pre-split on its separators so the panel can style each
   *  clause. Never build this string in JSX — that's what this module is for. */
  parts: string[];
  /** The same sentence, joined with " · " — the one-liner the panel renders. */
  text: string;
};

// How many size labels to name inline before collapsing to "+N more"; a 30-size
// run would otherwise turn the one-liner into a paragraph.
const MAX_NAMED_SIZES = 6;

export function computeSizeCoverage(
  styleSizes: readonly string[],
  rows: readonly SizeCoverageRow[],
): SizeCoverage {
  const boardSizes = dedupeSizes(styleSizes);

  // "Live" = will actually print. An operator-hidden row (StyleEan.excluded) is
  // deliberately NOT coverage — buildStyleData drops those before rendering, so
  // counting them would claim a size is covered while its label prints blank.
  const live = rows.filter((r) => (r.ean13 ?? "").trim() !== "" && !r.excluded);
  const scraped = new Set(live.filter((r) => !r.manual).map((r) => normalizeSize(r.size)));
  const byHand = new Set(live.filter((r) => r.manual).map((r) => normalizeSize(r.size)));

  const fromPo = boardSizes.filter((s) => scraped.has(normalizeSize(s)));
  const manual = boardSizes.filter(
    (s) => !scraped.has(normalizeSize(s)) && byHand.has(normalizeSize(s)),
  );
  const missing = boardSizes.filter(
    (s) => !scraped.has(normalizeSize(s)) && !byHand.has(normalizeSize(s)),
  );
  const boardSet = new Set(boardSizes.map(normalizeSize));
  const extra = dedupeSizes(live.filter((r) => !boardSet.has(normalizeSize(r.size))).map((r) => r.size));

  const parts: string[] = [];
  if (boardSizes.length === 0) {
    // No Sizes column (or it's empty): there's no expectation to compare
    // against, so state that plainly instead of implying 0-of-0 coverage.
    parts.push("No size run on this style's board row");
    parts.push(
      live.length > 0
        ? `${live.length} barcode ${plural(live.length, "row", "rows")} resolved from this PO`
        : "no barcodes resolved from this PO",
    );
  } else {
    parts.push(`Board lists ${boardSizes.length} ${plural(boardSizes.length, "size", "sizes")}`);
    if (fromPo.length === boardSizes.length) {
      parts.push(`this PO covers all ${boardSizes.length}`);
    } else if (fromPo.length === 0) {
      parts.push("this PO covers none of them");
    } else {
      parts.push(`this PO covers ${fromPo.length} (${nameSizes(fromPo)})`);
    }
    if (manual.length > 0) parts.push(`${manual.length} added by hand (${nameSizes(manual)})`);
    if (missing.length > 0) {
      parts.push(`${missing.length} with no barcode in this PO`);
    }
    if (extra.length > 0) {
      parts.push(
        `${extra.length} extra ${plural(extra.length, "row", "rows")} not on the board (${nameSizes(extra)})`,
      );
    }
  }

  return {
    boardSizes,
    fromPo,
    manual,
    missing,
    extra,
    complete: boardSizes.length > 0 && missing.length === 0,
    parts,
    text: parts.join(" · "),
  };
}

// Sizes are matched case-/whitespace-insensitively: the board run comes from
// splitSizes() (already trimmed) but a hand-added row is whatever the operator
// typed, and "27-30 " vs "27-30" must not read as an uncovered size.
function normalizeSize(size: string): string {
  return size.trim().toLowerCase();
}

// De-dupe while keeping the FIRST spelling and the original order — a size run
// is read left-to-right on the label, so order is meaningful.
function dedupeSizes(sizes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of sizes) {
    const s = raw.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function nameSizes(sizes: string[]): string {
  if (sizes.length <= MAX_NAMED_SIZES) return sizes.join(", ");
  return `${sizes.slice(0, MAX_NAMED_SIZES).join(", ")}, +${sizes.length - MAX_NAMED_SIZES} more`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
