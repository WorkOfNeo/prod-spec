import { test } from "node:test";
import assert from "node:assert/strict";
import {
  colourLettersFromCode,
  variantColourLetter,
  scopeVariantsByColour,
} from "./colour-scope";
import { parseBarcodeItems, selectStyleItems, variantsWithSectionCarton } from "./parse-barcodes";

// The flattened Barcodes page of a real Contrast PO (C-PO63293) — ONE style
// section (IL36494) listing TWO colourways. Two Pre-Order rows (Colour code
// "*A" and "*B") order against it; each must scrape only its own colour's
// EANs. Captured verbatim from pdf-parse.
const TWO_COLOURWAY_PAGE = [
  "No. Variant Description Barcode EAN Polybag EAN Carton SU per",
  "Polybag/Cart",
  "on",
  "C-33396 IL36494 - Pants",
  "ASS1 IL36494 - Pants 5706323597917 5706323597917 10/10",
  "A-M Colour A black/white, M 5706323597832",
  "A-L Colour A black/white, L 5706323597849",
  "A-XL Colour A black/white, XL 5706323597856",
  "A-2XL Colour A black/white, 2XL 5706323597863",
  "B-M Colour B navy/white, M 5706323597870",
  "B-L Colour B navy/white, L 5706323597887",
  "B-XL Colour B navy/white, XL 5706323597894",
  "B-2XL Colour B navy/white, 2XL 5706323597900",
  "Page 1\tPurchase Order C-PO63293 - Barcodes",
].join("\n");

test("colourLettersFromCode — starred single letters activate, colour names don't", () => {
  assert.deepEqual(colourLettersFromCode("*A"), ["A"]);
  assert.deepEqual(colourLettersFromCode("*B"), ["B"]);
  // Once a starred letter is present, a bare letter in the same value counts
  // too — a style that owns both colourways.
  assert.deepEqual(colourLettersFromCode("*A, B"), ["A", "B"]);
  assert.deepEqual(colourLettersFromCode("*a"), ["A"]);
  // Everything else the dropdown carries must NOT activate scoping.
  assert.deepEqual(colourLettersFromCode(""), []);
  assert.deepEqual(colourLettersFromCode("*Pink"), []);
  assert.deepEqual(colourLettersFromCode("*Mix"), []);
  assert.deepEqual(colourLettersFromCode("A-Black"), []);
  assert.deepEqual(colourLettersFromCode("B"), []); // bare letter, no star anywhere
  assert.deepEqual(colourLettersFromCode("A + A+ A"), []);
  // Starred colour name next to a starred letter — only the letter counts.
  assert.deepEqual(colourLettersFromCode("*A, *Pink"), ["A"]);
});

test("variantColourLetter — 'Colour X' token and single-letter prefix, nothing else", () => {
  assert.equal(variantColourLetter("A-M Colour A black/white, M"), "A");
  assert.equal(variantColourLetter("B-2XL Colour B navy/white, 2XL"), "B");
  assert.equal(variantColourLetter("A-ONE SIZE Colour A , One size"), "A");
  // Prefix alone is enough when the description has no "Colour X" token.
  assert.equal(variantColourLetter("A-S/M Black-Black, S/M"), "A");
  // Colour NAMES after "Colour" are not letters.
  assert.equal(variantColourLetter("M Colour navy/white, M"), null);
  // Two-letter colour abbreviations and dotted prefixes are not letter marks.
  assert.equal(variantColourLetter("PI-86/92 Pink, 86/92"), null);
  assert.equal(variantColourLetter("NA-122/128 Navy, 122/128"), null);
  assert.equal(variantColourLetter(".B-86/92 Blue, 86/92"), null);
});

test("scopeVariantsByColour — *A and *B each keep only their colourway", () => {
  const items = parseBarcodeItems(TWO_COLOURWAY_PAGE);
  assert.equal(items.length, 1);
  const selection = selectStyleItems(items, { styleNumber: "IL36494" });
  const variants = variantsWithSectionCarton(selection.items);
  assert.equal(variants.length, 8);

  const a = scopeVariantsByColour(variants, "*A");
  assert.equal(a.applied, true);
  assert.equal(a.excluded, 4);
  assert.deepEqual(
    a.variants.map((v) => v.ean13),
    ["5706323597832", "5706323597849", "5706323597856", "5706323597863"],
  );

  const b = scopeVariantsByColour(variants, "*B");
  assert.deepEqual(
    b.variants.map((v) => v.ean13),
    ["5706323597870", "5706323597887", "5706323597894", "5706323597900"],
  );

  // A style owning both colourways keeps all rows.
  const both = scopeVariantsByColour(variants, "*A, B");
  assert.equal(both.variants.length, 8);
  assert.equal(both.excluded, 0);
});

test("scopeVariantsByColour — inert without the letter convention on both sides", () => {
  const items = parseBarcodeItems(TWO_COLOURWAY_PAGE);
  const variants = variantsWithSectionCarton(items);

  // Colour-name code against letter-marked rows → no scoping, keep all.
  const name = scopeVariantsByColour(variants, "*Pink");
  assert.equal(name.applied, false);
  assert.equal(name.variants.length, 8);

  // "*A" against rows without letter marks → no scoping, keep all.
  const plain = [
    { label: "PI-86/92 Pink, 86/92" },
    { label: "PI-98/104 Pink, 98/104" },
  ];
  const noMarks = scopeVariantsByColour(plain, "*A");
  assert.equal(noMarks.applied, false);
  assert.equal(noMarks.variants.length, 2);
});

test("scopeVariantsByColour — letter mismatch scopes to empty rather than guessing", () => {
  const items = parseBarcodeItems(TWO_COLOURWAY_PAGE);
  const variants = variantsWithSectionCarton(items);
  const c = scopeVariantsByColour(variants, "*C");
  assert.equal(c.applied, true);
  assert.equal(c.variants.length, 0);
  assert.equal(c.excluded, 8);
});
