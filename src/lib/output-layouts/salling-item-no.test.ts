import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSallingItemNo as product, resolveSallingCartonItemNo as carton } from "./salling-item-no";

// The three shapes that occur in the live Salling column.
const LABELLED =
  "Carton: 933977900, Product: S: 933977001, M: 933977002, L: 933977003, XL: 933977004, 2XL: 933977005";
const LABELLED_NL = "Carton: 933894900,\nProduct: S: 933894001, M: 933894002, L: 933894003";
const PLAIN = "924126001, 924126002, 924126003, 924126004, 924126005";
const CARTON_ONLY = "Carton: 933985001";

const SML = ["S", "M", "L", "XL", "2XL"];
const RUN5 = ["98/104", "110/116", "122/128", "134/140", "146/152"];

// ---- carton ----

test("carton number is read from the labelled form", () => {
  assert.equal(carton(LABELLED), "933977900");
  assert.equal(carton(LABELLED_NL), "933894900");
});

test("carton number is read from a carton-only cell", () => {
  assert.equal(carton(CARTON_ONLY), "933985001");
});

test("a plain positional list has no carton number", () => {
  assert.equal(carton(PLAIN), "");
  assert.equal(carton(undefined), "");
  assert.equal(carton(""), "");
});

test("carton is row-independent — same value whatever the size", () => {
  assert.equal(carton(LABELLED), carton(LABELLED));
});

// ---- product, labelled ----

test("labelled form resolves each size, INCLUDING the first", () => {
  // The first size sits behind the "Product:" heading with no comma before
  // it — the case that used to hand back the whole raw cell.
  assert.equal(product(LABELLED, SML, ["S"]), "933977001");
  assert.equal(product(LABELLED, SML, ["M"]), "933977002");
  assert.equal(product(LABELLED, SML, ["L"]), "933977003");
  assert.equal(product(LABELLED, SML, ["XL"]), "933977004");
  assert.equal(product(LABELLED, SML, ["2XL"]), "933977005");
});

test("the carton number never leaks into the product value", () => {
  for (const size of SML) {
    assert.equal(product(LABELLED, SML, [size]).includes("933977900"), false);
  }
});

test("newline between the carton entry and the list is handled", () => {
  assert.equal(product(LABELLED_NL, ["S", "M", "L"], ["S"]), "933894001");
  assert.equal(product(LABELLED_NL, ["S", "M", "L"], ["L"]), "933894003");
});

test("a row size absent from a labelled list resolves empty", () => {
  assert.equal(product(LABELLED, [...SML, "3XL"], ["3XL"]), "");
});

test("several sizes on one row join with a comma", () => {
  assert.equal(product(LABELLED, SML, ["S", "M"]), "933977001, 933977002");
});

// ---- product, plain positional ----

test("plain list matches by position", () => {
  assert.equal(product(PLAIN, RUN5, ["98/104"]), "924126001");
  assert.equal(product(PLAIN, RUN5, ["122/128"]), "924126003");
  assert.equal(product(PLAIN, RUN5, ["146/152"]), "924126005");
});

test("a single value against a single size resolves", () => {
  assert.equal(product("890857009", ["54 - One Size"], ["54 - One Size"]), "890857009");
});

test("size labels match space-insensitively", () => {
  assert.equal(product(PLAIN, RUN5, ["98 / 104"]), "924126001");
});

// The guard: a length mismatch means we cannot say which number belongs to
// this size, so nothing prints rather than a guess.
test("a plain list whose length disagrees with the size run resolves empty", () => {
  assert.equal(product("924126001, 924126002", RUN5, ["98/104"]), "");
  assert.equal(product("1, 2, 3, 4, 5, 6", RUN5, ["98/104"]), "");
});

// ---- product, no product numbers ----

test("a carton-only cell has no product number", () => {
  assert.equal(product(CARTON_ONLY, ["35/38"], ["35/38"]), "");
});

test("empty / unknown inputs resolve empty", () => {
  assert.equal(product(undefined, SML, ["S"]), "");
  assert.equal(product("", SML, ["S"]), "");
  assert.equal(product("   ", SML, ["S"]), "");
  assert.equal(product(LABELLED, SML, []), "");
  assert.equal(product(PLAIN, [], ["98/104"]), "");
});
