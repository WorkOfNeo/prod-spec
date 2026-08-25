import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "@/lib/pdf/types";

// render.ts transitively imports @/lib/db, whose client construction needs
// DATABASE_URL at import time. Nothing here queries — the pg pool is lazy.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let repetitionStyles: typeof import("./render").repetitionStyles;

before(async () => {
  ({ repetitionStyles } = await import("./render"));
});

// A PO shipping the same size in BOTH a solid and an assortment packing:
// two style_eans rows, same size, same product EAN, different carton.
function tokmanniStyle(): StyleData {
  return {
    sizes: [{ label: "S", ean13: "5701234567104" }],
    carton: { ean13: "5709999999999" },
    eanVariants: [
      { size: "S", ean13: "5701234567104", colour: null, cartonEan: "5700000000011" },
      { size: "S", ean13: "5701234567104", colour: null, cartonEan: "5700000000022" },
      { size: "M", ean13: "5701234567111", colour: null, cartonEan: "5700000000011" },
    ],
  } as unknown as StyleData;
}

test("same size + same EAN repeats ONCE — one price sticker per size", () => {
  const reps = repetitionStyles(tokmanniStyle(), "ean");
  assert.equal(reps.length, 2);
  assert.deepEqual(reps.map((r) => r.sizes[0].label), ["S", "M"]);
});

test("different colourways of one size still repeat separately", () => {
  const style = {
    sizes: [{ label: "S", ean13: "1" }],
    carton: {},
    eanVariants: [
      { size: "S", ean13: "1", colour: "Pink", cartonEan: null },
      { size: "S", ean13: "2", colour: "Blue", cartonEan: null },
    ],
  } as unknown as StyleData;
  assert.equal(repetitionStyles(style, "ean").length, 2);
});

test("a merged repetition never loses a carton barcode", () => {
  // First row carries no carton, second does — the merged row must keep it,
  // or {{barcode:cartonEan}} would go blank where it used to print.
  const style = {
    sizes: [{ label: "S", ean13: "1" }],
    carton: { ean13: "" },
    eanVariants: [
      { size: "S", ean13: "1", colour: null, cartonEan: null },
      { size: "S", ean13: "1", colour: null, cartonEan: "5700000000011" },
    ],
  } as unknown as StyleData;
  const reps = repetitionStyles(style, "ean");
  assert.equal(reps.length, 1);
  assert.equal(reps[0].carton.ean13, "5700000000011");
});

test("distinct EAN rows are untouched — no existing layout loses a file", () => {
  const style = {
    sizes: [{ label: "S", ean13: "1" }],
    carton: {},
    eanVariants: [
      { size: "S", ean13: "1", colour: null, cartonEan: null },
      { size: "M", ean13: "2", colour: null, cartonEan: null },
      { size: "L", ean13: "3", colour: null, cartonEan: null },
    ],
  } as unknown as StyleData;
  assert.equal(repetitionStyles(style, "ean").length, 3);
});
