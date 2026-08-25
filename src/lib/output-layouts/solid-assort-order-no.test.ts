import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSolidAssortVariant, SOLID_ASSORT_KINDS } from "./carton-qty";
import { validateTokenRef } from "./token-meta";

// The Tokmanni cell, verbatim from PO 63368/63369.
const SPLIT = "Assort - 4530763 / Solid - 4530769";

test("customer order no split → each packing picks its own number", () => {
  assert.equal(pickSolidAssortVariant(SPLIT, "assort"), "4530763");
  assert.equal(pickSolidAssortVariant(SPLIT, "solid"), "4530769");
});

test("a plain order number serves both packings untouched", () => {
  // The single-packing PO — no marker, so neither arg narrows it. This is
  // what keeps every existing layout printing exactly what it printed.
  assert.equal(pickSolidAssortVariant("4530769", "solid"), "4530769");
  assert.equal(pickSolidAssortVariant("4530769", "assort"), "4530769");
});

test("a split missing the requested packing resolves empty, not the wrong number", () => {
  assert.equal(pickSolidAssortVariant("Assort - 4530763", "solid"), "");
});

test("an empty cell stays empty", () => {
  assert.equal(pickSolidAssortVariant("", "solid"), "");
  assert.equal(pickSolidAssortVariant(undefined, "assort"), "");
});

test("only solid/assort publish on an order number — no inner/outer box level", () => {
  assert.deepEqual([...SOLID_ASSORT_KINDS], ["solid", "assort"]);
  assert.deepEqual(validateTokenRef("customerOrderNo", "solid"), []);
  assert.deepEqual(validateTokenRef("customerOrderNo", "assort"), []);
  assert.deepEqual(validateTokenRef("customerOrderNo", undefined), []);
  // {{qtyPerCarton:outer}} is valid; {{customerOrderNo:outer}} is a mistake.
  assert.deepEqual(validateTokenRef("qtyPerCarton", "outer"), []);
  assert.equal(validateTokenRef("customerOrderNo", "outer").length, 1);
});
