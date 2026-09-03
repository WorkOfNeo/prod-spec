import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeCoverPage, coverNameBody, coverBodyMentionsStyle, carriesLayoutId } from "./file-name-shape";

test("the app's own cover convention is recognised, with and without a colour", () => {
  assert.equal(looksLikeCoverPage("00-ab10001-cover-page.pdf"), true);
  assert.equal(looksLikeCoverPage("00-ab10001-navy-blue-cover-page.pdf"), true);
});

test("hand-made cover names are recognised too — that is the point of the loose test", () => {
  assert.equal(looksLikeCoverPage("Cover Page.pdf"), true);
  assert.equal(looksLikeCoverPage("AB10001 cover_page FINAL.pdf"), true);
});

test("an ordinary output is not cover-page-shaped", () => {
  assert.equal(looksLikeCoverPage("ab10001-care-label.pdf"), false);
  // "cover" alone is not enough — a hangtag cover material sheet must not match.
  assert.equal(looksLikeCoverPage("ab10001-cover-material.pdf"), false);
});

test("the convention body is the style plus any colour, lowercased", () => {
  assert.equal(coverNameBody("00-AB10001-cover-page.pdf"), "ab10001");
  assert.equal(coverNameBody("00-ab10001-navy-blue-cover-page.pdf"), "ab10001-navy-blue");
});

test("a name that is not the convention has no body", () => {
  assert.equal(coverNameBody("Cover Page.pdf"), null);
  assert.equal(coverNameBody("ab10001-cover-page.pdf"), null, "the 00- prefix is part of the convention");
});

test("a body belongs to a style by whole segment, never by prefix", () => {
  assert.equal(coverBodyMentionsStyle("ab10001", "ab10001"), true);
  assert.equal(coverBodyMentionsStyle("ab10001-blue", "ab10001"), true);
  // The regression this guards: a longer style number must not adopt a
  // shorter one's cover, or a delete would be proposed against the wrong style.
  assert.equal(coverBodyMentionsStyle("ab100011", "ab10001"), false);
  assert.equal(coverBodyMentionsStyle("ab10001", ""), false);
});

test("a leaked layout id is recognised in both spellings", () => {
  // The variant key carries a colon; sanitizeFileName rewrites it to a hyphen
  // on the way into SharePoint, so both shapes exist in the wild.
  assert.equal(carriesLayoutId("ab10001-layout:clw9k2h4x0000abcd1234efgh-s.pdf"), true);
  assert.equal(carriesLayoutId("ab10001-layout-clw9k2h4x0000abcd1234efgh-s.pdf"), true);
});

test("an ordinary name mentioning layouts is not a leak", () => {
  assert.equal(carriesLayoutId("ab10001-care-label.pdf"), false);
  assert.equal(carriesLayoutId("approved-layout-guide.pdf"), false, "no long id follows");
  // A word merely ending in "layout" must not trip the boundary.
  assert.equal(carriesLayoutId("productlayout-clw9k2h4x0000abcd1234efgh.pdf"), false);
});
