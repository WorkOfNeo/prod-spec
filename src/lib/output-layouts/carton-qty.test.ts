import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCartonQtyVariant, pickSolidAssortVariant } from "./carton-qty";

test("Solid/Assort split → each variant picks its own number", () => {
  const raw = "Solid - 5 / Assort - 8";
  assert.equal(pickCartonQtyVariant(raw, "solid"), "5");
  assert.equal(pickCartonQtyVariant(raw, "assort"), "8");
});

test("separator and spacing variants", () => {
  assert.equal(pickCartonQtyVariant("Solid-5/Assort-8", "assort"), "8");
  assert.equal(pickCartonQtyVariant("SOLID : 12 / ASSORT : 24", "solid"), "12");
  assert.equal(pickCartonQtyVariant("solid = 6, assort = 10", "assort"), "10");
});

test("a plain single value serves both variants untouched", () => {
  assert.equal(pickCartonQtyVariant("48", "solid"), "48");
  assert.equal(pickCartonQtyVariant("48", "assort"), "48");
});

test("a per-size list (no Solid/Assort) is handed back untouched", () => {
  // What repetitionStyles narrows a "SIZE=qty" column to for one row.
  assert.equal(pickCartonQtyVariant("1040", "assort"), "1040");
});

test("a split missing the requested variant resolves empty (→ amber gap)", () => {
  assert.equal(pickCartonQtyVariant("Assort - 8", "solid"), "");
  // Solid present but blank before the next variant's number.
  assert.equal(pickCartonQtyVariant("Solid - / Assort - 8", "solid"), "");
});

test("empty / undefined input", () => {
  assert.equal(pickCartonQtyVariant("", "solid"), "");
  assert.equal(pickCartonQtyVariant(undefined, "assort"), "");
});

test("buyers' spelling variants of the two labels", () => {
  // "Assortment" (the long form) — the shape that sent {{qtyPerCarton:assort}}
  // blank on 12 live styles even though the solid side resolved fine.
  assert.equal(pickCartonQtyVariant("Assortment=12/ Solid=10", "assort"), "12");
  assert.equal(pickCartonQtyVariant("Assortment=12/ Solid=10", "solid"), "10");
  assert.equal(pickCartonQtyVariant("Solid-20/ Assortment-24", "assort"), "24");
  assert.equal(pickCartonQtyVariant("Assortment= 12, Solid = 20", "assort"), "12");
  // "ASS" / "AST" abbreviations.
  assert.equal(pickCartonQtyVariant("ASS : 23 , SOLID : 20", "assort"), "23");
  assert.equal(pickCartonQtyVariant("ASS: 25, SOLID: 25", "solid"), "25");
  assert.equal(
    pickCartonQtyVariant("For AST - 12 PCS PER CARTON/ SOLID - polybag", "assort"),
    "12",
  );
  // "Soild" — the typo on 35 live styles, which blanked the SOLID side.
  assert.equal(pickCartonQtyVariant("Soild - 20 / Assort - 24", "solid"), "20");
  assert.equal(pickCartonQtyVariant("Soild - 20 / Assort - 24", "assort"), "24");
});

test("an alias only counts as a whole word", () => {
  // "assort" inside "assortment" must not steal the match and leave the
  // trailing "ment=" unconsumed; the long form wins.
  assert.equal(pickCartonQtyVariant("Assortment= 14 / Solid= 20", "assort"), "14");
  // A plain number is still not a split, whatever the kind asked for.
  assert.equal(pickCartonQtyVariant("24", "assort"), "24");
});

test("the aliases carry to the shared solid/assort primitive", () => {
  // {{customerOrderNo:solid|assort}} reuses the same picker, so a Tokmanni
  // order-number cell spelled the long way narrows too.
  assert.equal(pickSolidAssortVariant("Assortment - 4530763 / Soild - 4530769", "assort"), "4530763");
  assert.equal(pickSolidAssortVariant("Assortment - 4530763 / Soild - 4530769", "solid"), "4530769");
});
