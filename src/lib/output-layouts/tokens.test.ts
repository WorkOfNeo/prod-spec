import { test } from "node:test";
import assert from "node:assert/strict";
import type { SiblingStyle, StyleData } from "@/lib/pdf/types";
import { resolveTextToken } from "./tokens";

// {{multipleStylesDescriptions}} collapses the base style + the picked
// same-PO siblings into one comma-joined description list for a "Multiple
// styles on the box" carton print. These lock the de-dupe: styles that carry
// an identical description print it ONCE (3 identical → a single entry), so a
// carton for several styles that share a description doesn't repeat it.

function makeSibling(over: Partial<SiblingStyle> & { description: string }): SiblingStyle {
  return {
    id: over.id ?? over.description,
    styleNumber: "",
    styleName: "",
    customerItemNo: "",
    colourName: "",
    colourCode: "",
    sizes: "",
    sizeRange: "",
    qtyPerCarton: "",
    cartonEan: "",
    ean13: "",
    ...over,
  };
}

function makeStyle(over: Partial<StyleData>): StyleData {
  return {
    styleName: "Base Style",
    styleNumber: "IL0001",
    customerName: "Netto A/S",
    businessArea: "PL",
    composition: [],
    productNameTranslations: [],
    washSymbols: [],
    sizes: [],
    carton: { klNumber: "", supplierNumber: "", lot: "", outerVE: 0, ean13: "" },
    ...over,
  };
}

const descList = (s: StyleData) => resolveTextToken(s, "multipleStylesDescriptions");

test("three styles with the SAME description print it once", () => {
  const style = makeStyle({
    description: "T-Shirt Paw Patrol",
    multipleStyles: true,
    siblings: [
      makeSibling({ description: "T-Shirt Paw Patrol" }),
      makeSibling({ description: "T-Shirt Paw Patrol" }),
    ],
  });
  assert.equal(descList(style), "T-Shirt Paw Patrol");
});

test("distinct descriptions all print, in base-then-slot order", () => {
  const style = makeStyle({
    description: "Alpha",
    multipleStyles: true,
    siblings: [makeSibling({ description: "Bravo" }), makeSibling({ description: "Charlie" })],
  });
  assert.equal(descList(style), "Alpha, Bravo, Charlie");
});

test("only the repeats collapse — the first occurrence is kept", () => {
  const style = makeStyle({
    description: "Alpha",
    multipleStyles: true,
    siblings: [
      makeSibling({ description: "Alpha" }),
      makeSibling({ description: "Bravo" }),
      makeSibling({ description: "Bravo" }),
      makeSibling({ description: "Charlie" }),
    ],
  });
  assert.equal(descList(style), "Alpha, Bravo, Charlie");
});

test("match is case- and whitespace-insensitive, but keeps the first spelling", () => {
  const style = makeStyle({
    description: "Kids  Tee", // double space
    multipleStyles: true,
    siblings: [makeSibling({ description: "kids tee" }), makeSibling({ description: "KIDS TEE" })],
  });
  assert.equal(descList(style), "Kids  Tee");
});

test("blank / whitespace-only sibling descriptions are dropped (no dangling comma)", () => {
  const style = makeStyle({
    description: "Alpha",
    multipleStyles: true,
    siblings: [
      makeSibling({ description: "   " }),
      makeSibling({ description: "" }),
      makeSibling({ description: "Alpha" }),
    ],
  });
  assert.equal(descList(style), "Alpha");
});

test("single-style mode ignores the sibling pool — just the base description", () => {
  const style = makeStyle({
    description: "Alpha",
    multipleStyles: false,
    siblings: [makeSibling({ description: "Bravo" })],
  });
  assert.equal(descList(style), "Alpha");
});
