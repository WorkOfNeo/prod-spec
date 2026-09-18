import { test } from "node:test";
import assert from "node:assert/strict";
import type { StyleData, SizeVariant } from "@/lib/pdf/types";
import { resolveTextToken } from "./tokens";
import { validateTokenRef } from "./token-meta";

// Token-level wiring for Salling's two-number Customer Item No column.
// The parser itself is covered in salling-item-no.test.ts; these lock the
// argument plumbing, the row scoping, and that the bare token is unchanged.

const RAW =
  "Carton: 933977900, Product: S: 933977001, M: 933977002, L: 933977003, XL: 933977004, 2XL: 933977005";
const sv = (label: string): SizeVariant => ({ label, ean13: "" }) as SizeVariant;

function makeStyle(over: Partial<StyleData>): StyleData {
  return {
    styleName: "Base Style",
    styleNumber: "IL0001",
    customerName: "Salling Group A/S",
    businessArea: "PL",
    composition: [],
    productNameTranslations: [],
    washSymbols: [],
    sizes: [],
    carton: { klNumber: "", supplierNumber: "", lot: "", outerVE: 0, ean13: "" },
    ...over,
  } as StyleData;
}

// A repetition row: `sizes` narrowed to one, `allSizes` the full run —
// exactly what repetitionStyles hands the resolver.
function row(size: string, raw = RAW): StyleData {
  return makeStyle({
    customerItemNoRaw: raw,
    sizes: [sv(size)],
    allSizes: ["S", "M", "L", "XL", "2XL"].map(sv),
  });
}

test("{{customerItemNo:salling}} resolves the row's own product number", () => {
  assert.equal(resolveTextToken(row("S"), "customerItemNo", "salling"), "933977001");
  assert.equal(resolveTextToken(row("L"), "customerItemNo", "salling"), "933977003");
  assert.equal(resolveTextToken(row("2XL"), "customerItemNo", "salling"), "933977005");
});

test("{{customerItemNo:sallingCarton}} is the same on every row", () => {
  for (const size of ["S", "M", "L", "XL", "2XL"]) {
    assert.equal(resolveTextToken(row(size), "customerItemNo", "sallingCarton"), "933977900");
  }
});

test("a plain positional list resolves per row", () => {
  const plain = "924126001, 924126002, 924126003";
  const sizes = ["98/104", "110/116", "122/128"];
  const at = (i: number) =>
    makeStyle({ customerItemNoRaw: plain, sizes: [sv(sizes[i])], allSizes: sizes.map(sv) });
  assert.equal(resolveTextToken(at(0), "customerItemNo", "salling"), "924126001");
  assert.equal(resolveTextToken(at(2), "customerItemNo", "salling"), "924126003");
  // …and carries no carton number.
  assert.equal(resolveTextToken(at(0), "customerItemNo", "sallingCarton"), "");
});

test("the bare token is untouched — still the pre-narrowed row value", () => {
  const style = makeStyle({ customerItemNo: "933977002", customerItemNoRaw: RAW, sizes: [sv("M")] });
  assert.equal(resolveTextToken(style, "customerItemNo"), "933977002");
});

test("both selectors validate, and a wrong one is rejected", () => {
  assert.deepEqual(validateTokenRef("customerItemNo", "salling"), []);
  assert.deepEqual(validateTokenRef("customerItemNo", "sallingCarton"), []);
  assert.deepEqual(validateTokenRef("customerItemNo", undefined), []);
  assert.equal(validateTokenRef("customerItemNo", "carton").length, 1);
});
