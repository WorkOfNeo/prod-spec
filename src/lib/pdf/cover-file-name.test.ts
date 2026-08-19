import { test } from "node:test";
import assert from "node:assert/strict";
import { coverColourLabel, coverFileName } from "./cover-file-name";

test("colour name wins when it is set", () => {
  assert.equal(coverColourLabel({ name: "Navy", code: "*Blue" }), "Navy");
});

test("falls back to the colour code when the name is empty", () => {
  assert.equal(coverColourLabel({ name: "", code: "*Blue" }), "Blue");
  assert.equal(coverColourLabel({ name: "   ", code: "*Yellow" }), "Yellow");
});

test("strips only LEADING asterisks off the code", () => {
  assert.equal(coverColourLabel({ name: "", code: "*Blue" }), "Blue");
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

test("the two colourways of one style number get DIFFERENT cover names", () => {
  const blue = coverFileName("LV60153", { name: "", code: "*Blue" });
  const yellow = coverFileName("LV60153", { name: "", code: "*Yellow" });
  assert.equal(blue, "00-lv60153-blue-cover-page.pdf");
  assert.equal(yellow, "00-lv60153-yellow-cover-page.pdf");
  assert.notEqual(blue, yellow);
});

test("a style with no colour keeps the name it has today", () => {
  // The regression that matters: ~2,200 live styles carry no colour at all and
  // must not be renamed, or every one of their delivered covers goes stale.
  assert.equal(coverFileName("LV60153", { name: "", code: "" }), "00-lv60153-cover-page.pdf");
  assert.equal(coverFileName("LV60153", null), "00-lv60153-cover-page.pdf");
});

test("a colour of only punctuation adds no segment", () => {
  assert.equal(coverFileName("LV60153", { name: "", code: "*" }), "00-lv60153-cover-page.pdf");
  assert.equal(coverFileName("LV60153", { name: "-", code: "" }), "00-lv60153-cover-page.pdf");
});

test("spaces and punctuation in a colour are slugged, never left raw", () => {
  const name = coverFileName("LV60153", { name: "Navy Blue", code: "" });
  assert.equal(name, "00-lv60153-navy-blue-cover-page.pdf");
  assert.ok(!/[ /\\:*?"<>|]/.test(name), "must be safe as a SharePoint file name");
});
