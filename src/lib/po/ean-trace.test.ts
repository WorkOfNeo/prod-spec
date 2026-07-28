import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEanResolveTrace, parseEanResolveTrace } from "./ean-trace";
import type { EanDiagnostics } from "./ean-view";
import type { SizeEan } from "./resolve-style-eans";

// The trace exists to answer one question the eanStatus enum could not:
// "which source produced these barcodes, and what did the other one see?".
// These tests pin the attribution logic, because getting it wrong would print a
// confident and WRONG provenance next to a barcode — worse than showing nothing.

const DIAG = (over: Partial<EanDiagnostics> = {}): EanDiagnostics => ({
  poNumber: "C-PO1",
  poFileName: "Purchase Order C-PO1.pdf",
  poFileId: "id",
  candidateCount: 1,
  candidates: [],
  queriesTried: ["C-PO1"],
  poFileWebUrl: "https://sp/po.pdf",
  supplierFolderUrl: null,
  barcodePageFound: true,
  pdfPageCount: 4,
  pdfTextLength: 900,
  ean13TokensInFullText: 6,
  parsedItemCount: 2,
  parsedVariantCount: 3,
  matchedByCustomerItemNo: false,
  matchedByStyleNumber: true,
  customerItemNoOnStyle: null,
  styleNumberOnStyle: "HK1",
  poStyleNumbers: ["HK1", "HK2"],
  colourCodeOnStyle: null,
  colourLetters: [],
  colourScopeApplied: false,
  variantsExcludedByColour: 0,
  styleSizes: ["S", "M"],
  textSnippet: "",
  poSections: [],
  ...over,
});

const size = (s: string, ean: string | null, carton: string | null = null): SizeEan => ({
  size: s,
  ean13: ean,
  variantLabel: null,
  cartonEan: carton,
});

test("PO produced the EANs → every size attributed to the PO", () => {
  const po = [size("S", "1111111111111"), size("M", "2222222222222")];
  const t = buildEanResolveTrace({
    at: new Date("2026-07-28T10:00:00Z"),
    status: "RESOLVED",
    message: null,
    forced: false,
    diagnostics: DIAG(),
    poStatusWasReject: false,
    poSizeEans: po,
    finalSizeEans: po,
    fallback: null,
    overlay: null,
    mondayConsulted: true,
    cartonEan: null,
  });

  assert.deepEqual(t.sizes.map((s) => s.source), ["po", "po"]);
  assert.equal(t.monday.mode, "no-data");
  assert.equal(t.po?.eansFound, 2);
  assert.match(t.po!.outcome, /Read 2 barcode\(s\)/);
});

test("Monday fallback won → sizes attributed to Monday, raw columns preserved", () => {
  // The PO scrape found the file but matched nothing; Monday rescued it. The
  // raw column text is the whole point — it's what the buyer actually typed.
  const t = buildEanResolveTrace({
    at: new Date("2026-07-28T10:00:00Z"),
    status: "RESOLVED_FROM_MONDAY",
    message: "Barcodes read from Monday",
    forced: true,
    diagnostics: DIAG({ parsedVariantCount: 0 }),
    poStatusWasReject: false,
    poSizeEans: [size("S", null), size("M", null)],
    finalSizeEans: [size("S", "9999999999999", "8888888888888"), size("M", "7777777777777")],
    fallback: {
      sizeEans: [],
      cartonEan: null,
      matchedSizes: 2,
      assortEan: null,
      productField: "S: 9999999999999, M: 7777777777777",
      cartonField: "S: 8888888888888",
      invalid: ["12345"],
    },
    overlay: null,
    mondayConsulted: true,
    cartonEan: null,
  });

  assert.deepEqual(t.sizes.map((s) => s.source), ["monday", "monday"]);
  assert.equal(t.monday.mode, "fallback");
  assert.equal(t.monday.productField, "S: 9999999999999, M: 7777777777777");
  assert.deepEqual(t.monday.invalid, ["12345"]);
  assert.equal(t.po?.eansFound, 0);
  assert.match(t.monday.outcome, /2 of 2 size\(s\)/);
  assert.equal(t.forced, true);
});

test("carton overlay → product EANs stay attributed to the PO", () => {
  // Regression guard: the overlay only replaces CARTON EANs. Attributing the
  // product EANs to Monday here would be a lie.
  const po = [size("S", "1111111111111", "5555555555555")];
  const t = buildEanResolveTrace({
    at: new Date("2026-07-28T10:00:00Z"),
    status: "RESOLVED",
    message: null,
    forced: false,
    diagnostics: DIAG(),
    poStatusWasReject: false,
    poSizeEans: po,
    finalSizeEans: [size("S", "1111111111111", "6666666666666")],
    fallback: null,
    overlay: { bySize: [{ sizeKey: "S", ean: "6666666666666" }], assort: null, cartonField: "S: 6666666666666" },
    mondayConsulted: true,
    cartonEan: null,
  });

  assert.deepEqual(t.sizes.map((s) => s.source), ["po"]);
  assert.equal(t.monday.mode, "carton-overlay");
  assert.equal(t.monday.cartonField, "S: 6666666666666");
  assert.equal(t.carton.perSize, 1);
});

test("style not in PO → outcome names the refusal, not a vague failure", () => {
  const t = buildEanResolveTrace({
    at: new Date("2026-07-28T10:00:00Z"),
    status: "STYLE_NOT_IN_PO",
    message: null,
    forced: false,
    diagnostics: DIAG(),
    poStatusWasReject: true,
    poSizeEans: [],
    finalSizeEans: [],
    fallback: null,
    overlay: null,
    mondayConsulted: false,
    cartonEan: null,
  });

  assert.equal(t.po?.matchedBy, "rejected");
  assert.match(t.po!.outcome, /HK1, HK2/);
  assert.match(t.po!.outcome, /Refused/);
  assert.equal(t.monday.mode, "not-needed");
});

test("no PO number → po is null, not a fabricated failure", () => {
  const t = buildEanResolveTrace({
    at: new Date("2026-07-28T10:00:00Z"),
    status: "NONE",
    message: "Style has no PO number",
    forced: false,
    diagnostics: undefined,
    poStatusWasReject: false,
    poSizeEans: [],
    finalSizeEans: [],
    fallback: null,
    overlay: null,
    mondayConsulted: false,
    cartonEan: null,
  });
  assert.equal(t.po, null);
});

test("parseEanResolveTrace rejects junk and wrong versions", () => {
  assert.equal(parseEanResolveTrace(null), null);
  assert.equal(parseEanResolveTrace("nope"), null);
  assert.equal(parseEanResolveTrace({ v: 2, at: "x", monday: {}, sizes: [] }), null);
  assert.equal(parseEanResolveTrace({ v: 1, at: "x", monday: {}, sizes: [] })?.v, 1);
});
