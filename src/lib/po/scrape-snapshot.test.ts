import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPoScrapeSnapshot,
  computeSizeCoverage,
  parsePoScrapeSnapshot,
  MAX_SNAPSHOT_SECTIONS,
  MAX_SNAPSHOT_VARIANTS_PER_SECTION,
  PO_SCRAPE_SNAPSHOT_VERSION,
  type SizeCoverageRow,
} from "./scrape-snapshot";
import type { EanDiagnostics } from "./ean-view";

const SCRAPED_AT = new Date("2026-07-28T09:15:00.000Z");

// A real-shaped EanDiagnostics: the C-PO63315 scrape (multi-style Contrast PO)
// as resolveStyleEans builds it, including the bulky fields the snapshot must
// drop (textSnippet, candidates, PDF stats).
function diagnostics(over: Partial<EanDiagnostics> = {}): EanDiagnostics {
  return {
    poNumber: "C-PO63315",
    poFileName: "Purchase Order C-PO63315.pdf",
    poFileId: "01ABCDEF",
    candidateCount: 3,
    candidates: [
      { name: "Purchase Order C-PO63315.pdf", score: 120, webUrl: "https://sp/po.pdf" },
      { name: "Purchase Order C-PO63315 rev2.pdf", score: 90, webUrl: null },
    ],
    queriesTried: ["C-PO63315", "PO63315"],
    poFileWebUrl: "https://sp/po.pdf",
    supplierFolderUrl: "https://sp/supplier",
    barcodePageFound: true,
    pdfPageCount: 4,
    pdfTextLength: 18234,
    ean13TokensInFullText: 42,
    parsedItemCount: 3,
    parsedVariantCount: 2,
    matchedByCustomerItemNo: false,
    matchedByStyleNumber: true,
    customerItemNoOnStyle: null,
    styleNumberOnStyle: "PTQ60031",
    poStyleNumbers: ["PTQ60032", "PTQ60031", "PTQ10046"],
    colourCodeOnStyle: "*B",
    colourLetters: ["B"],
    colourScopeApplied: true,
    variantsExcludedByColour: 1,
    styleSizes: ["86/92", "98/104", "110/116", "122/128"],
    textSnippet: "No. Variant Description Barcode EAN Polybag EAN Carton SU per…",
    poSections: [
      {
        styleNumber: "PTQ60032",
        contrastNo: "C-33418",
        selected: false,
        variants: [{ label: "PI-86/92 Pink, 86/92", ean13: "5706323598907", used: false }],
        cartonEan: "5706323598945",
      },
      {
        styleNumber: "PTQ60031",
        contrastNo: "C-33423",
        selected: true,
        variants: [
          { label: ".B-86/92 Blue, 86/92", ean13: "5706323599140", used: true },
          { label: ".B-98/104 Blue, 98/104", ean13: "5706323599140", used: true },
        ],
        cartonEan: "5706323599188",
      },
    ],
    ...over,
  };
}

test("buildPoScrapeSnapshot — keeps the section dump + match context, drops the bulk", () => {
  const snap = buildPoScrapeSnapshot(diagnostics(), SCRAPED_AT);

  assert.equal(snap.version, PO_SCRAPE_SNAPSHOT_VERSION);
  assert.equal(snap.scrapedAt, "2026-07-28T09:15:00.000Z");
  assert.equal(snap.poFileName, "Purchase Order C-PO63315.pdf");
  assert.equal(snap.poFileWebUrl, "https://sp/po.pdf");
  assert.equal(snap.sectionCount, 2);
  assert.equal(snap.truncated, false);

  // The whole point: every section, not just the matched one, with the
  // per-variant used flag intact so "green = used" still renders.
  assert.equal(snap.sections.length, 2);
  const selected = snap.sections.filter((s) => s.selected);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].styleNumber, "PTQ60031");
  assert.equal(selected[0].cartonEan, "5706323599188");
  assert.deepEqual(
    selected[0].variants.map((v) => [v.label, v.ean13, v.used]),
    [
      [".B-86/92 Blue, 86/92", "5706323599140", true],
      [".B-98/104 Blue, 98/104", "5706323599140", true],
    ],
  );

  // Match context — the "why these sections" half of the explanation.
  assert.equal(snap.matchedByStyleNumber, true);
  assert.equal(snap.matchedByCustomerItemNo, false);
  assert.deepEqual(snap.poStyleNumbers, ["PTQ60032", "PTQ60031", "PTQ10046"]);
  assert.equal(snap.colourCodeOnStyle, "*B");
  assert.deepEqual(snap.colourLetters, ["B"]);
  assert.equal(snap.colourScopeApplied, true);
  assert.equal(snap.variantsExcludedByColour, 1);
  assert.deepEqual(snap.styleSizes, ["86/92", "98/104", "110/116", "122/128"]);

  // Bulk that must never reach the JSONB column (this lands on every style).
  const keys = Object.keys(snap);
  for (const dropped of [
    "textSnippet",
    "candidates",
    "candidateCount",
    "queriesTried",
    "pdfPageCount",
    "pdfTextLength",
    "ean13TokensInFullText",
    "supplierFolderUrl",
    "poFileId",
  ]) {
    assert.equal(keys.includes(dropped), false, `${dropped} must not be persisted`);
  }
  // And nothing sneaks in via the section rows either.
  assert.deepEqual(Object.keys(snap.sections[0]).sort(), [
    "cartonEan",
    "contrastNo",
    "selected",
    "styleNumber",
    "variants",
  ]);
});

test("buildPoScrapeSnapshot — caps sections, flags truncation, keeps the matched one", () => {
  // A jumbo consolidated PO where OUR section sits well past the cap — the one
  // section the panel exists to show must survive the trim.
  const many = Array.from({ length: MAX_SNAPSHOT_SECTIONS + 25 }, (_, i) => ({
    styleNumber: `STY${i}`,
    contrastNo: `C-${i}`,
    selected: i === MAX_SNAPSHOT_SECTIONS + 10,
    variants: [{ label: `L${i}`, ean13: "5706323599140", used: i === MAX_SNAPSHOT_SECTIONS + 10 }],
    cartonEan: null,
  }));
  const snap = buildPoScrapeSnapshot(diagnostics({ poSections: many }), SCRAPED_AT);

  assert.equal(snap.sections.length, MAX_SNAPSHOT_SECTIONS);
  assert.equal(snap.sectionCount, MAX_SNAPSHOT_SECTIONS + 25);
  assert.equal(snap.truncated, true);
  assert.equal(snap.sections[0].styleNumber, `STY${MAX_SNAPSHOT_SECTIONS + 10}`);
  assert.equal(snap.sections[0].selected, true);
});

test("buildPoScrapeSnapshot — caps per-section variants and flags it", () => {
  const fat = [
    {
      styleNumber: "PTQ60031",
      contrastNo: "C-33423",
      selected: true,
      variants: Array.from({ length: MAX_SNAPSHOT_VARIANTS_PER_SECTION + 5 }, (_, i) => ({
        label: `size-${i}`,
        ean13: "5706323599140",
        used: true,
      })),
      cartonEan: null,
    },
  ];
  const snap = buildPoScrapeSnapshot(diagnostics({ poSections: fat }), SCRAPED_AT);

  assert.equal(snap.sections[0].variants.length, MAX_SNAPSHOT_VARIANTS_PER_SECTION);
  assert.equal(snap.sections[0].variants[0].label, "size-0");
  assert.equal(snap.truncated, true);
  // Only the variant list was cut — the section count is honest.
  assert.equal(snap.sectionCount, 1);
});

test("parsePoScrapeSnapshot — round-trips through JSONB unchanged", () => {
  const snap = buildPoScrapeSnapshot(diagnostics(), SCRAPED_AT);
  // Exactly what Prisma hands back from a Json column.
  const fromDb: unknown = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(parsePoScrapeSnapshot(fromDb), snap);
});

test("parsePoScrapeSnapshot — never throws on legacy / garbage input", () => {
  for (const junk of [
    null,
    undefined,
    "",
    "not json",
    42,
    true,
    [],
    [{ version: 1 }],
    {},
    { version: 0 },
    { version: "1" },
    // A newer deploy's shape: refuse it outright rather than half-read it.
    { version: 2, sections: [] },
    { poSections: [{ styleNumber: "X" }] }, // the pre-snapshot diagnostics shape
  ]) {
    assert.equal(parsePoScrapeSnapshot(junk), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

test("parsePoScrapeSnapshot — degrades field-by-field instead of losing the panel", () => {
  const parsed = parsePoScrapeSnapshot({
    version: 1,
    scrapedAt: 12345, // wrong type
    poFileName: "Purchase Order C-PO63315.pdf",
    // poFileWebUrl / styleSizes / poStyleNumbers missing entirely
    sections: [
      {
        styleNumber: "PTQ60031",
        contrastNo: null,
        selected: true,
        cartonEan: null,
        variants: [{ label: "A", ean13: "5706323599140", used: "yes" }],
      },
      "this is not a section",
    ],
    colourScopeApplied: "nope",
    variantsExcludedByColour: null,
  });

  assert.notEqual(parsed, null);
  assert.equal(parsed!.poFileName, "Purchase Order C-PO63315.pdf");
  assert.equal(parsed!.poFileWebUrl, null);
  assert.deepEqual(parsed!.styleSizes, []);
  assert.equal(parsed!.colourScopeApplied, false);
  assert.equal(parsed!.variantsExcludedByColour, 0);
  // One unusable section row poisons the array, not the snapshot.
  assert.deepEqual(parsed!.sections, []);
  assert.equal(parsed!.sectionCount, 0);
});

test("parsePoScrapeSnapshot — falls back to Style.eanResolvedAt for the 'when'", () => {
  const stored = { ...buildPoScrapeSnapshot(diagnostics(), SCRAPED_AT), scrapedAt: null };
  const resolvedAt = new Date("2026-07-01T08:00:00.000Z");

  assert.equal(parsePoScrapeSnapshot(stored, resolvedAt)?.scrapedAt, "2026-07-01T08:00:00.000Z");
  // Own timestamp always wins over the fallback.
  const own = buildPoScrapeSnapshot(diagnostics(), SCRAPED_AT);
  assert.equal(parsePoScrapeSnapshot(own, resolvedAt)?.scrapedAt, "2026-07-28T09:15:00.000Z");
  // Unusable fallbacks degrade to null rather than "Invalid Date".
  assert.equal(parsePoScrapeSnapshot(stored, null)?.scrapedAt, null);
  assert.equal(parsePoScrapeSnapshot(stored, "not a date")?.scrapedAt, null);
});

// ---------------------------------------------------------------------------
// Size coverage
// ---------------------------------------------------------------------------

function row(over: Partial<SizeCoverageRow> & { size: string }): SizeCoverageRow {
  return { ean13: "5706323599140", excluded: false, manual: false, ...over };
}

test("computeSizeCoverage — the reported case: PO carries only some size groups", () => {
  // The style's board row lists four size groups; the PO for THIS row only
  // carried two — the rest sat on a different Monday row under another PO.
  const c = computeSizeCoverage(
    ["27-30", "31-34", "35-38", "39-42"],
    [
      row({ size: "27-30" }),
      row({ size: "31-34" }),
      row({ size: "35-38", ean13: null }),
      row({ size: "39-42", ean13: null }),
    ],
  );

  assert.deepEqual(c.fromPo, ["27-30", "31-34"]);
  assert.deepEqual(c.missing, ["35-38", "39-42"]);
  assert.deepEqual(c.manual, []);
  assert.deepEqual(c.extra, []);
  assert.equal(c.complete, false);
  assert.equal(
    c.text,
    "Board lists 4 sizes · this PO covers 2 (27-30, 31-34) · 2 with no barcode in this PO",
  );
  assert.equal(c.parts.length, 3);
});

test("computeSizeCoverage — all covered", () => {
  const c = computeSizeCoverage(["S", "M", "L"], [row({ size: "S" }), row({ size: "M" }), row({ size: "L" })]);
  assert.equal(c.complete, true);
  assert.deepEqual(c.missing, []);
  assert.equal(c.text, "Board lists 3 sizes · this PO covers all 3");
});

test("computeSizeCoverage — none covered", () => {
  const c = computeSizeCoverage(
    ["S", "M"],
    [row({ size: "S", ean13: null }), row({ size: "M", ean13: null })],
  );
  assert.deepEqual(c.fromPo, []);
  assert.deepEqual(c.missing, ["S", "M"]);
  assert.equal(c.complete, false);
  assert.equal(
    c.text,
    "Board lists 2 sizes · this PO covers none of them · 2 with no barcode in this PO",
  );
});

test("computeSizeCoverage — zero sizes on the board", () => {
  const empty = computeSizeCoverage([], []);
  assert.deepEqual(empty.boardSizes, []);
  assert.equal(empty.complete, false);
  assert.equal(
    empty.text,
    "No size run on this style's board row · no barcodes resolved from this PO",
  );

  // Unknown sizes → resolveStyleEans surfaces the raw variant labels as rows.
  const labelled = computeSizeCoverage([], [row({ size: ".B-86/92 Blue, 86/92" })]);
  assert.deepEqual(labelled.extra, [".B-86/92 Blue, 86/92"]);
  assert.equal(
    labelled.text,
    "No size run on this style's board row · 1 barcode row resolved from this PO",
  );
});

test("computeSizeCoverage — an excluded row is NOT coverage", () => {
  // Hidden rows are dropped by buildStyleData before anything renders, so a
  // size whose only EAN is de-selected prints blank — it must read as missing.
  const c = computeSizeCoverage(
    ["S", "M"],
    [row({ size: "S" }), row({ size: "M", excluded: true })],
  );
  assert.deepEqual(c.fromPo, ["S"]);
  assert.deepEqual(c.missing, ["M"]);
  assert.equal(c.text, "Board lists 2 sizes · this PO covers 1 (S) · 1 with no barcode in this PO");
});

test("computeSizeCoverage — a hand-added row is counted separately from the PO", () => {
  const c = computeSizeCoverage(
    ["S", "M", "L"],
    [row({ size: "S" }), row({ size: " m ", manual: true }), row({ size: "L", ean13: null })],
  );
  assert.deepEqual(c.fromPo, ["S"]);
  assert.deepEqual(c.manual, ["M"]); // matched case-/whitespace-insensitively
  assert.deepEqual(c.missing, ["L"]);
  assert.equal(
    c.text,
    "Board lists 3 sizes · this PO covers 1 (S) · 1 added by hand (M) · 1 with no barcode in this PO",
  );
  // A hand-added barcode still closes the gap for rendering purposes.
  assert.equal(c.complete, false);
  const filled = computeSizeCoverage(["S", "M"], [row({ size: "S" }), row({ size: "M", manual: true })]);
  assert.equal(filled.complete, true);
});

test("computeSizeCoverage — rows for sizes the board doesn't list are flagged", () => {
  const c = computeSizeCoverage(
    ["S", "M"],
    [row({ size: "S" }), row({ size: "M" }), row({ size: "XXL" })],
  );
  assert.deepEqual(c.extra, ["XXL"]);
  assert.equal(
    c.text,
    "Board lists 2 sizes · this PO covers all 2 · 1 extra row not on the board (XXL)",
  );
});

test("computeSizeCoverage — long size runs collapse the inline list", () => {
  const sizes = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const c = computeSizeCoverage(sizes, [...sizes.map((s) => row({ size: s })), row({ size: "9" })]);
  // "covers all N" avoids naming them; the extras list is the one that caps.
  assert.match(c.text, /covers all 8/);
  const partial = computeSizeCoverage(
    [...sizes, "9"],
    sizes.map((s) => row({ size: s })),
  );
  assert.match(partial.text, /this PO covers 8 \(1, 2, 3, 4, 5, 6, \+2 more\)/);
});

test("computeSizeCoverage — a duplicated board size counts once", () => {
  // Multi-colourway styles repeat a size across colours; the board run itself
  // can also carry an accidental duplicate. Either way it's one size.
  const c = computeSizeCoverage(["S", "S", "M"], [row({ size: "S" }), row({ size: "S" })]);
  assert.deepEqual(c.boardSizes, ["S", "M"]);
  assert.deepEqual(c.fromPo, ["S"]);
  assert.deepEqual(c.missing, ["M"]);
});
