import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "../pdf/types";

// See assort.test.ts — the render/tokens modules transitively construct the db
// client at import time, so a dummy DATABASE_URL lets them load (nothing here
// queries; the pool is lazy). Node runs each test file in its own process.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let barcodeSymbology: typeof import("./render").barcodeSymbology;
let resolveBarcodeValue: typeof import("./tokens").resolveBarcodeValue;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ barcodeSymbology } = await import("./render"));
  ({ resolveBarcodeValue } = await import("./tokens"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

test("cartonEan13 → same carton value as cartonEan, but forced EAN-13 symbology", () => {
  const s = buildSampleStyleData();
  const carton = s.carton.ean13!;
  // Same value…
  assert.equal(resolveBarcodeValue(s, "cartonEan13"), carton);
  assert.equal(resolveBarcodeValue(s, "cartonEan13"), resolveBarcodeValue(s, "cartonEan"));
  // …different symbology: {{barcode:cartonEan}} is the carton default (Code128/
  // EAN-128); {{barcode:cartonEan13}} is always a true EAN-13, from the layout
  // alone — no ProdSpec dropdown needed.
  assert.equal(barcodeSymbology(s, "cartonEan"), "ean128");
  assert.equal(barcodeSymbology(s, "cartonEan13"), "ean13");
});

test("cartonEan13 stays EAN-13 regardless of the ProdSpec dropdown; cartonEan still follows it", () => {
  const base = buildSampleStyleData();
  // Simulate the legacy per-ProdSpec dropdown flipping the carton to EAN-13
  // (applyCartonBarcodePrefs sets style.cartonBarcode).
  const dropdownEan13: StyleData = { ...base, cartonBarcode: { type: "ean13" } };
  assert.equal(barcodeSymbology(dropdownEan13, "cartonEan"), "ean13"); // fallback honored
  assert.equal(barcodeSymbology(dropdownEan13, "cartonEan13"), "ean13");
  // With the dropdown left at its default, the explicit token still wins.
  const dropdownDefault: StyleData = { ...base, cartonBarcode: { type: "ean128" } };
  assert.equal(barcodeSymbology(dropdownDefault, "cartonEan"), "ean128");
  assert.equal(barcodeSymbology(dropdownDefault, "cartonEan13"), "ean13");
});
