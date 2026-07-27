import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCartonQtyVariant } from "./carton-qty";

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
