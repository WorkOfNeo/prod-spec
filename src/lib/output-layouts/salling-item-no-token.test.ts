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

test("{{customerItemNo:product}} resolves the row's own product number", () => {
  assert.equal(resolveTextToken(row("S"), "customerItemNo", "product"), "933977001");
  assert.equal(resolveTextToken(row("L"), "customerItemNo", "product"), "933977003");
  assert.equal(resolveTextToken(row("2XL"), "customerItemNo", "product"), "933977005");
});

test("{{customerItemNo:carton}} is the same on every row", () => {
  for (const size of ["S", "M", "L", "XL", "2XL"]) {
    assert.equal(resolveTextToken(row(size), "customerItemNo", "carton"), "933977900");
  }
});

// The names #359 shipped under. Published layouts were authored against
// ":salling", so these must keep resolving identically — forever, unless
// those layouts are re-authored.
test("the legacy :salling / :sallingCarton aliases still resolve", () => {
  for (const size of ["S", "M", "L", "XL", "2XL"]) {
    assert.equal(
      resolveTextToken(row(size), "customerItemNo", "salling"),
      resolveTextToken(row(size), "customerItemNo", "product"),
    );
    assert.equal(
      resolveTextToken(row(size), "customerItemNo", "sallingCarton"),
      resolveTextToken(row(size), "customerItemNo", "carton"),
    );
  }
  assert.equal(resolveTextToken(row("S"), "customerItemNo", "salling"), "933977001");
  assert.equal(resolveTextToken(row("S"), "customerItemNo", "sallingCarton"), "933977900");
});

// The whole point of the rename: a carton marking asked for the carton
// number and got the entire cell, product numbers and all.
test("the carton selector never falls through to the raw cell", () => {
  const got = resolveTextToken(row("S"), "customerItemNo", "carton");
  assert.equal(got, "933977900");
  assert.equal(got.includes("Product"), false);
  assert.equal(got.includes("933977001"), false);
});

test("a plain positional list resolves per row", () => {
  const plain = "924126001, 924126002, 924126003";
  const sizes = ["98/104", "110/116", "122/128"];
  const at = (i: number) =>
    makeStyle({ customerItemNoRaw: plain, sizes: [sv(sizes[i])], allSizes: sizes.map(sv) });
  assert.equal(resolveTextToken(at(0), "customerItemNo", "product"), "924126001");
  assert.equal(resolveTextToken(at(2), "customerItemNo", "product"), "924126003");
  // …and carries no carton number.
  assert.equal(resolveTextToken(at(0), "customerItemNo", "carton"), "");
});

test("the bare token is untouched — still the pre-narrowed row value", () => {
  const style = makeStyle({ customerItemNo: "933977002", customerItemNoRaw: RAW, sizes: [sv("M")] });
  assert.equal(resolveTextToken(style, "customerItemNo"), "933977002");
});

test("canonical names and legacy aliases all validate", () => {
  for (const arg of ["product", "carton", "salling", "sallingCarton", undefined]) {
    assert.deepEqual(validateTokenRef("customerItemNo", arg), [], `${arg} should validate`);
  }
});

test("an unknown selector is still rejected, and suggests the canonical pair", () => {
  const errs = validateTokenRef("customerItemNo", "cartons");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /\{\{customerItemNo:product\}\}/);
  assert.match(errs[0], /\{\{customerItemNo:carton\}\}/);
  // The legacy names are accepted but never suggested.
  assert.equal(errs[0].includes("salling"), false);
});
