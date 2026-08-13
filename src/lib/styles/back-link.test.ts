import { test } from "node:test";
import assert from "node:assert/strict";
import { isKnownStylesFilter, stylesBackHref, stylesBackLabel } from "./back-link";

test("a stashed filter is replayed verbatim", () => {
  assert.equal(stylesBackHref("q=12345&customer=Netto", "C-PO12345"), "/styles?q=12345&customer=Netto");
  // A leading "?" (whatever the caller stashed) is tolerated.
  assert.equal(stylesBackHref("?q=12345", "C-PO12345"), "/styles?q=12345");
});

test("no stashed filter falls back to the style's own PO", () => {
  assert.equal(stylesBackHref(null, "C-PO12345"), "/styles?q=C-PO12345");
  assert.equal(stylesBackHref("", "C-PO12345"), "/styles?q=C-PO12345");
  assert.equal(stylesBackHref(null, "  C-PO12345 "), "/styles?q=C-PO12345");
});

test("no filter and no PO falls back to the plain table", () => {
  assert.equal(stylesBackHref(null, null), "/styles");
  assert.equal(stylesBackHref("", "   "), "/styles");
});

test("junk in sessionStorage never builds the URL", () => {
  assert.equal(stylesBackHref("evil=1", "C-PO12345"), "/styles?q=C-PO12345");
  assert.equal(stylesBackHref("https://example.com/", "C-PO12345"), "/styles?q=C-PO12345");
  assert.equal(stylesBackHref("q=" + "x".repeat(3000), "C-PO12345"), "/styles?q=C-PO12345");
  assert.ok(!isKnownStylesFilter(""));
  assert.ok(!isKnownStylesFilter("tab=test"));
  assert.ok(isKnownStylesFilter("with=po&without=supplier&archived=1&reviewer=Ida"));
});

test("a PO in the search is named in the label", () => {
  assert.equal(stylesBackLabel("q=12345", "C-PO12345"), "Back to PO C-PO12345");
  assert.equal(stylesBackLabel("q=C-PO12345", "C-PO12345"), "Back to PO C-PO12345");
  assert.equal(stylesBackLabel(null, "C-PO12345"), "Back to PO C-PO12345");
});

test("a non-PO search or a facet-only filter gets a generic label", () => {
  assert.equal(stylesBackLabel("q=hoodie", "C-PO12345"), "Back to “hoodie”");
  assert.equal(stylesBackLabel("customer=Netto", "C-PO12345"), "Back to filtered styles");
  assert.equal(stylesBackLabel(null, null), "All styles");
});
