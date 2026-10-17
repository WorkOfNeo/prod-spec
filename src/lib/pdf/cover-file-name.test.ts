import { test } from "node:test";
import assert from "node:assert/strict";
import { coverColourApplies, coverColourLabel, coverFileName } from "./cover-file-name";

// A style at/above the cutoff, so the naming tests below exercise the new shape.
// The numbers are illustrative — the real cutoff is an app setting.
const IN_SCOPE = { poSeq: 50200, minPo: 50000 };

test("colour name wins when it is set", () => {
  assert.equal(coverColourLabel({ name: "Navy", code: "*Blue" }), "Navy");
});

test("falls back to the colour code when the name is empty", () => {
  assert.equal(coverColourLabel({ name: "", code: "*Blue" }), "Blue");
  assert.equal(coverColourLabel({ name: "   ", code: "*Yellow" }), "Yellow");
});

test("strips only LEADING asterisks off the code", () => {
  assert.equal(coverColourLabel({ name: "", code: "**Blue" }), "Blue");
  assert.equal(coverColourLabel({ name: "", code: "* Blue" }), "Blue");
  // An asterisk that is part of the code itself survives.
  assert.equal(coverColourLabel({ name: "", code: "A*2" }), "A*2");
});

test("no colour at all resolves to an empty label", () => {
  assert.equal(coverColourLabel({ name: "", code: "" }), "");
  assert.equal(coverColourLabel(undefined), "");
  assert.equal(coverColourLabel(null), "");
});

// ---------------------------------------------------------------------
// The cutoff gate. This is what keeps the colour out of the archive: a style
// below the cutoff never gains a colour segment in its cover name.
// ---------------------------------------------------------------------

test("the cutoff gate: at or above the cutoff is in, below is out", () => {
  assert.equal(coverColourApplies(50200, 50000), true);
  assert.equal(coverColourApplies(50000, 50000), true, "the cutoff PO itself is IN");
  assert.equal(coverColourApplies(49999, 50000), false);
  assert.equal(coverColourApplies(1, 50000), false);
});

test("the cutoff gate: an unset cutoff renames NOTHING", () => {
  // Mirrors reconcileSupplierSendQueue — without an explicit cutoff the change
  // must never reach back over the whole historical book.
  assert.equal(coverColourApplies(50200, null), false);
  assert.equal(coverColourApplies(null, null), false);
});

test("the cutoff gate: a style with no parseable PO is left alone", () => {
  assert.equal(coverColourApplies(null, 50000), false);
  assert.equal(coverColourApplies(undefined, 50000), false);
});

test("the two colourways of one style number get DIFFERENT cover names", () => {
  const blue = coverFileName({ styleNumber: "AB10001", colour: { name: "", code: "*Blue" }, ...IN_SCOPE });
  const yellow = coverFileName({ styleNumber: "AB10001", colour: { name: "", code: "*Yellow" }, ...IN_SCOPE });
  assert.equal(blue, "00-ab10001-blue-prod-spec.pdf");
  assert.equal(yellow, "00-ab10001-yellow-prod-spec.pdf");
  assert.notEqual(blue, yellow);
});

test("below the cutoff, a coloured style gets no colour segment", () => {
  // The regression that matters most: this is every already-delivered cover.
  assert.equal(
    coverFileName({ styleNumber: "AB10001", colour: { name: "", code: "*Blue" }, poSeq: 49000, minPo: 50000 }),
    "00-ab10001-prod-spec.pdf",
  );
});

test("with no cutoff configured, no colour is added even above it", () => {
  assert.equal(
    coverFileName({ styleNumber: "AB10001", colour: { name: "Navy", code: "" }, poSeq: 99999, minPo: null }),
    "00-ab10001-prod-spec.pdf",
  );
});

test("a style with no colour is named on the style number alone", () => {
  assert.equal(coverFileName({ styleNumber: "AB10001", colour: { name: "", code: "" }, ...IN_SCOPE }), "00-ab10001-prod-spec.pdf");
  assert.equal(coverFileName({ styleNumber: "AB10001", colour: null, ...IN_SCOPE }), "00-ab10001-prod-spec.pdf");
});

test("a colour of only punctuation adds no segment", () => {
  assert.equal(coverFileName({ styleNumber: "AB10001", colour: { name: "", code: "*" }, ...IN_SCOPE }), "00-ab10001-prod-spec.pdf");
  assert.equal(coverFileName({ styleNumber: "AB10001", colour: { name: "-", code: "" }, ...IN_SCOPE }), "00-ab10001-prod-spec.pdf");
});

test("spaces and punctuation in a colour are slugged, never left raw", () => {
  const name = coverFileName({ styleNumber: "AB10001", colour: { name: "Navy Blue", code: "" }, ...IN_SCOPE });
  assert.equal(name, "00-ab10001-navy-blue-prod-spec.pdf");
  assert.ok(!/[ /\\:*?"<>|]/.test(name), "must be safe as a SharePoint file name");
});

test("every cover is named prod-spec, never the old cover-page spelling", () => {
  // Below the cutoff too: the old spelling is not grandfathered, so "Fix output
  // filenames" renames already-delivered covers in place.
  for (const input of [
    { styleNumber: "AB10001", colour: null, poSeq: 49000, minPo: 50000 },
    { styleNumber: "AB10001", colour: { name: "Navy", code: "" }, ...IN_SCOPE },
    { styleNumber: "AB10001", colour: { name: "Navy", code: "" }, poSeq: null, minPo: null },
  ]) {
    const name = coverFileName(input);
    assert.ok(name.endsWith("-prod-spec.pdf"), name);
    assert.ok(!name.includes("cover-page"), name);
  }
});
