import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCoverPageHtml, type CoverPageInput } from "./bundle-pages";

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
