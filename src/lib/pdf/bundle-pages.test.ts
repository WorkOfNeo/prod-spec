import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderCoverPageHtml,
  hasPendingRows,
  type BundleDocSummary,
  type CoverPageInput,
} from "./bundle-pages";

// The cover document is general info's ONLY home in the bundle — the runner no
// longer ships a standalone general-information PDF. These tests lock the two
// invariants that requirement rests on:
//   1. the cover sheet and general info live in ONE document (one PDF), and
//   2. the cover sheet ALWAYS renders before the general-information pages.
// If either flips, a supplier could receive the requirements before the cover
// (or in a separate file) — the exact thing this design forbids.

const baseInput: CoverPageInput = {
  customerName: "Acme",
  businessArea: "Apparel",
  styleName: "Test Style",
  styleNumber: "12345",
  poNumber: "PO-1",
  supplierName: "SupplierCo",
  // Fixed date — deterministic output, independent of the wall clock.
  generatedAt: new Date("2026-06-25T00:00:00Z"),
  docs: [{ displayName: "Care Label 01", widthMm: 35, heightMm: 50, fileCount: 1 }],
};

test("general info is appended after the cover, in the same document", () => {
  const html = renderCoverPageHtml({
    ...baseInput,
    generalInfo: { markdown: "## Washing\n\nUNIQUE_GI_MARKER content" },
  });

  // One HTML document => one PDF.
  assert.equal(
    html.split("<!DOCTYPE html>").length - 1,
    1,
    "cover + general info must be a single HTML document (one PDF)",
  );

  // Structural order in the body: cover section (sec0/.cov) precedes the
  // general-info section (sec1/.md).
  const coverSection = html.indexOf('<div class="sec0">');
  const giSection = html.indexOf('<div class="sec1">');
  assert.ok(coverSection >= 0, "cover section present");
  assert.ok(giSection > coverSection, "general info is section 1, after the cover section");

  const coverBlock = html.indexOf('<div class="cov">');
  const giBlock = html.indexOf('<div class="md">');
  assert.ok(coverBlock >= 0 && giBlock > coverBlock, "cover block renders before the markdown block");

  // Content order: the cover heading precedes the general-info content.
  const coverHeading = html.indexOf("Production specification");
  const giContent = html.indexOf("UNIQUE_GI_MARKER");
  assert.ok(coverHeading >= 0 && giContent >= 0, "both cover and general-info content present");
  assert.ok(coverHeading < giContent, "the cover page must render before general information");
});

test("no general info => single-section cover, no general-info pages", () => {
  const html = renderCoverPageHtml({ ...baseInput, generalInfo: null });
  assert.ok(html.includes('<div class="sec0">'), "cover section present");
  assert.ok(!html.includes('<div class="sec1">'), "no second section without general info");
  assert.ok(!html.includes('<div class="md">'), "no markdown/general-info block without general info");
});

// The pending-row label is supplier-facing wording agreed with Contrast. It is
// printed in TWO places on the cover — the manifest's Status cell and the note
// paragraph that explains it — and both must say the same thing, or the note
// explains a marking the supplier can't find in the table.
const PENDING_LABEL = "Waiting for Customer Information";

test("a pending row is flagged with the agreed label, in the table and the note", () => {
  const html = renderCoverPageHtml({
    ...baseInput,
    generalInfo: null,
    docs: [
      { displayName: "Care Label 01", widthMm: 35, heightMm: 50, fileCount: 1, approved: true },
      { displayName: "Hangtag Coop", widthMm: 55, heightMm: 90, fileCount: 1, approved: false },
    ],
  });

  assert.ok(html.includes(`<span class="await">${PENDING_LABEL}</span>`), "status cell uses the label");
  assert.ok(html.includes(`<strong>${PENDING_LABEL}</strong>`), "explanatory note uses the same label");
  assert.ok(html.includes(`<span class="ok">Approved</span>`), "approved rows still read Approved");
  assert.ok(html.includes("<th>Status</th>"), "one pending row switches the Status column on");

  // The old wording must not survive anywhere on the cover.
  assert.ok(!html.includes("Awaiting Contrast"), "the pre-rename wording is gone");
});

test("all-approved cover shows no Status column and no pending label", () => {
  const html = renderCoverPageHtml({
    ...baseInput,
    generalInfo: null,
    docs: [{ displayName: "Care Label 01", widthMm: 35, heightMm: 50, fileCount: 1, approved: true }],
  });
  assert.ok(!html.includes("<th>Status</th>"), "no Status column when nothing is pending");
  assert.ok(!html.includes(PENDING_LABEL), "no pending label when nothing is pending");
});

// hasPendingRows is the single predicate behind two decisions that must agree:
// whether the cover PRINTS the pending wording, and whether the "Regenerate
// cover pages" sweep bothers rebuilding + re-pushing that cover at all. If they
// ever diverged, the sweep would skip covers that do show the wording, or churn
// suppliers' files for finished orders. These tests pin them together.

const doc = (approved?: boolean) => ({
  displayName: "Doc",
  widthMm: 10,
  heightMm: 10,
  fileCount: 1,
  ...(approved === undefined ? {} : { approved }),
});

test("hasPendingRows — true only when a row is explicitly not approved", () => {
  assert.equal(hasPendingRows([doc(false)]), true, "one pending row");
  assert.equal(hasPendingRows([doc(true), doc(false)]), true, "mixed counts as pending");
  assert.equal(hasPendingRows([doc(true), doc(true)]), false, "all approved");
  assert.equal(hasPendingRows([]), false, "empty manifest");

  // undefined ≠ pending. The editor preview passes no approval state at all;
  // treating that as pending would make the sweep rebuild every such cover.
  assert.equal(hasPendingRows([doc(undefined)]), false, "untracked approval is not pending");
  assert.equal(hasPendingRows([doc(true), doc(undefined)]), false, "approved + untracked");
});

test("hasPendingRows agrees with what the cover actually renders", () => {
  // The contract the sweep's skip relies on: predicate false ⇒ the rendered
  // page contains no pending wording, so rebuilding it is a visual no-op.
  for (const docs of [
    [doc(true)],
    [doc(true), doc(true)],
    [doc(undefined)],
    [doc(true), doc(undefined)],
  ]) {
    const html = renderCoverPageHtml({ ...baseInput, generalInfo: null, docs });
    assert.equal(hasPendingRows(docs), false, "precondition: predicate says nothing pending");
    assert.ok(!html.includes(PENDING_LABEL), "so the page shows no pending label");
    assert.ok(!html.includes("<th>Status</th>"), "and no Status column");
  }

  // And the converse: predicate true ⇒ the wording IS on the page, so the
  // sweep must NOT skip it.
  for (const docs of [[doc(false)], [doc(true), doc(false)], [doc(false), doc(undefined)]]) {
    const html = renderCoverPageHtml({ ...baseInput, generalInfo: null, docs });
    assert.equal(hasPendingRows(docs), true, "precondition: predicate says pending");
    assert.ok(html.includes(PENDING_LABEL), "so the page shows the pending label");
    assert.ok(html.includes("<th>Status</th>"), "and the Status column");
  }
});

// ---- Trims on the manifest -------------------------------------------------

const coverInput = (docs: BundleDocSummary[]) => ({
  customerName: "COOP Danmark",
  businessArea: "Private Label",
  styleName: "IL00000",
  styleNumber: "IL00000",
  poNumber: "C-PO00000",
  supplierName: "Rhythm Knit India",
  generatedAt: new Date("2026-08-13T00:00:00Z"),
  docs,
});

test("a Monday entry prints its own wording, with the document beneath it", () => {
  const html = renderCoverPageHtml(
    coverInput([
      {
        displayName: "Wash Care Label with Oeko-tex Logo",
        sourceLabel: "Wash Care Label with Oeko-tex Logo",
        suppliedAs: ["Coop DK - Private Label - Care Label"],
        widthMm: 25,
        heightMm: 120,
        fileCount: 1,
        approved: false,
        kind: "app",
      },
    ]),
  );
  assert.ok(html.includes("Wash Care Label with Oeko-tex Logo"));
  assert.ok(html.includes("Supplied as Coop DK - Private Label - Care Label"));
  assert.ok(html.includes("25 × 120 mm"));
});

test("a row with no single document behind it prints no size", () => {
  const html = renderCoverPageHtml(
    coverInput([
      {
        displayName: "Main label with size",
        sourceLabel: "Main label with size",
        widthMm: null,
        heightMm: null,
        fileCount: null,
        approved: false,
        kind: "manual",
      },
    ]),
  );
  // The em dash stands in for the size; no stray "NaN" or "null mm".
  assert.ok(html.includes('<td class="size">—</td>'));
  assert.ok(!html.includes("null"));
  assert.ok(!html.includes("NaN"));
});

test("a packing instruction says what it is instead of waiting forever", () => {
  const html = renderCoverPageHtml(
    coverInput([
      { displayName: "Hangtag", widthMm: null, heightMm: null, fileCount: null, approved: false, kind: "manual" },
      { displayName: "Black Hanger", widthMm: null, heightMm: null, fileCount: null, kind: "info" },
    ]),
  );
  assert.ok(html.includes("See packing instructions"));
  // …and the note explains that marking, alongside the pending one.
  assert.ok(html.includes("packaging materials rather than"));
  assert.ok(html.includes("Waiting for Customer Information"));
});

test("the packing-instruction wording is absent when no such row is on the page", () => {
  // Same trap as the pending label: explaining a marking the supplier cannot
  // find on the page is worse than saying nothing.
  const html = renderCoverPageHtml(
    coverInput([
      { displayName: "Hangtag", widthMm: null, heightMm: null, fileCount: null, approved: false, kind: "manual" },
    ]),
  );
  assert.ok(!html.includes("See packing instructions"));
  assert.ok(!html.includes("packaging materials rather than"));
});

test("an info row is not a pending row", () => {
  // It has no delivery state at all, so it must not switch the Status column on
  // by itself — otherwise every style with a polybag grows a column of
  // "See packing instructions" and nothing else.
  assert.equal(
    hasPendingRows([{ approved: true }, { approved: undefined }]),
    false,
  );
});
