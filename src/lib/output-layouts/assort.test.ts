import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "../pdf/types";

// render.ts / tokens.ts transitively import @/lib/db (care-labels, translations),
// whose client construction needs DATABASE_URL at import time. Nothing here ever
// queries — the pg pool is lazy — so a dummy URL lets the modules load. Set it
// before the dynamic imports below (node runs each test file in its own process).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let repetitionStyles: typeof import("./render").repetitionStyles;
let barcodeSymbology: typeof import("./render").barcodeSymbology;
let resolveBarcodeValue: typeof import("./tokens").resolveBarcodeValue;
let resolveTextToken: typeof import("./tokens").resolveTextToken;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;
let ASSORT: string;

before(async () => {
  ({ repetitionStyles, barcodeSymbology } = await import("./render"));
  ({ resolveBarcodeValue, resolveTextToken } = await import("./tokens"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
  ASSORT = buildSampleStyleData().carton.assortEan!; // sample master carton
});

test("assortEan13 → same master-carton value as assortEan, but EAN-13 symbology", () => {
  const s = buildSampleStyleData();
  // Same value…
  assert.equal(resolveBarcodeValue(s, "assortEan13"), ASSORT);
  assert.equal(resolveBarcodeValue(s, "assortEan13"), resolveBarcodeValue(s, "assortEan"));
  // …different symbology: assortEan is the carton default (Code128/EAN-128),
  // assortEan13 is a true EAN-13 so a layout can choose.
  assert.equal(barcodeSymbology(s, "assortEan"), "ean128");
  assert.equal(barcodeSymbology(s, "assortEan13"), "ean13");
  assert.equal(barcodeSymbology(s, "cartonEan"), "ean128");
  assert.equal(barcodeSymbology(s, "ean13"), "ean13");
});

test("assortEan token + barcode source resolve the master carton", () => {
  const s = buildSampleStyleData();
  assert.equal(resolveTextToken(s, "assortEan"), ASSORT);
  assert.equal(resolveBarcodeValue(s, "assortEan"), ASSORT);
  // Distinct from the per-row carton (carton.ean13) on the base style.
  assert.notEqual(s.carton.assortEan, s.carton.ean13);
});

test("repeatBy 'assort' → one assortment row that prints the master carton", () => {
  const reps = repetitionStyles(buildSampleStyleData(), "assort");
  assert.equal(reps.length, 1);
  const row = reps[0];
  assert.equal(row.isAssortment, true);
  assert.equal(resolveTextToken(row, "isAssortment"), "1");
  // The assort binds onto carton.ean13 too, so {{barcode:cartonEan}} AND
  // {{barcode:assortEan}} both print the master carton on the assortment label.
  assert.equal(resolveBarcodeValue(row, "cartonEan"), ASSORT);
  assert.equal(resolveBarcodeValue(row, "assortEan"), ASSORT);
});

test("repeatBy 'assort' with NO assort → row still emitted, barcode empty (→ editable in review)", () => {
  const base = buildSampleStyleData();
  const noAssort: StyleData = { ...base, carton: { ...base.carton, assortEan: "0000000000000" } };
  const reps = repetitionStyles(noAssort, "assort");
  assert.equal(reps.length, 1);
  assert.equal(reps[0].isAssortment, true);
  // No master carton → assortEan resolves empty (missing state); carton.ean13
  // is NOT overwritten with the sentinel.
  assert.equal(resolveBarcodeValue(reps[0], "assortEan"), "");
  assert.equal(reps[0].carton.ean13, base.carton.ean13);
});

test("repeatBy 'cartonEan' → one row per per-size carton + a final assort row", () => {
  const base = buildSampleStyleData();
  const perSize = base.carton.perSize!;
  const reps = repetitionStyles(base, "cartonEan");
  // 6 distinct per-size cartons in the sample + 1 appended assort master.
  assert.equal(reps.length, perSize.length + 1);

  // Each per-size row binds its OWN carton onto carton.ean13 (so
  // {{barcode:cartonEan}} / {{barcode:cartonEan13}} print that size's carton),
  // narrows {{size}} to the covered size, and is NOT flagged assortment.
  perSize.forEach((v, i) => {
    const row = reps[i];
    assert.equal(row.isAssortment, undefined);
    assert.equal(resolveTextToken(row, "size"), v.size);
    assert.equal(resolveBarcodeValue(row, "cartonEan"), v.cartonEan);
  });

  // Final row = the assortment master carton.
  const last = reps[reps.length - 1];
  assert.equal(last.isAssortment, true);
  assert.equal(resolveBarcodeValue(last, "cartonEan"), base.carton.assortEan);
  assert.equal(resolveBarcodeValue(last, "assortEan"), base.carton.assortEan);
});

test("repeatBy 'cartonEan' → sizes sharing a carton EAN collapse to ONE marking", () => {
  const base = buildSampleStyleData();
  const shared = "5700000000009"; // valid check digit
  const style: StyleData = {
    ...base,
    carton: {
      ...base.carton,
      assortEan: "0000000000000", // no assort → only the per-size rows
      perSize: [
        { size: "S", cartonEan: shared, productEan13: "", colour: null },
        { size: "M", cartonEan: shared, productEan13: "", colour: null },
        { size: "L", cartonEan: base.carton.perSize![3].cartonEan, productEan13: "", colour: null },
      ],
    },
  };
  const reps = repetitionStyles(style, "cartonEan");
  // Two distinct cartons (S+M share one, L its own); no assort row.
  assert.equal(reps.length, 2);
  // The shared-carton row lists BOTH sizes ({{sizes}}), first is {{size}}.
  assert.equal(resolveTextToken(reps[0], "size"), "S");
  assert.equal(resolveBarcodeValue(reps[0], "cartonEan"), shared);
  assert.equal(resolveTextToken(reps[0], "sizes"), "S, M");
});

test("repeatBy 'cartonEan' → assort row's {{size}} lists ALL sizes (not just the first)", () => {
  // The assort master carton covers the whole run, so a per-carton file name
  // like "…-{{size}}" must not name the assort PDF after one arbitrary size.
  const base = buildSampleStyleData();
  const sizes = ["XS", "S", "M", "L", "XL", "XXL"].map((label) => ({ label, ean13: "" }));
  const style: StyleData = { ...base, sizes };
  const reps = repetitionStyles(style, "cartonEan");
  const last = reps[reps.length - 1];
  assert.equal(last.isAssortment, true);
  // {{size}} on the assortment row = every size joined by "-" (slug-safe), so
  // the file name shows the whole run, not just "XS".
  assert.equal(resolveTextToken(last, "size"), "XS-S-M-L-XL-XXL");
  // A per-size (non-assort) row still shows just its single size.
  assert.equal(resolveTextToken(reps[0], "size"), base.carton.perSize![0].size);
});

test("repeatBy 'cartonEan' → narrowing is IDEMPOTENT (one marking per per-carton PDF)", () => {
  // renderMany narrows the style to ONE carton row, then hands that row back to
  // renderLayoutHtml, which re-applies repetitionStyles. Re-applying to an
  // already-narrowed row MUST return that same single row — otherwise the row's
  // inherited carton.perSize re-expands and EVERY per-carton PDF contains ALL
  // the markings (XS gets all, M gets all, …). Same invariant repeatBy "ean"
  // keeps by narrowing eanVariants to the current row.
  const base = buildSampleStyleData();
  const reps = repetitionStyles(base, "cartonEan");
  assert.ok(reps.length > 1, "sample must fan out to several carton rows");

  for (const row of reps) {
    const again = repetitionStyles(row, "cartonEan");
    assert.equal(again.length, 1);
    assert.equal(resolveBarcodeValue(again[0], "cartonEan"), resolveBarcodeValue(row, "cartonEan"));
    assert.equal(again[0].isAssortment, row.isAssortment);
    assert.equal(resolveTextToken(again[0], "size"), resolveTextToken(row, "size"));
  }
});

test("repeatBy 'cartonEan' with no cartons at all → falls back to one whole-style row", () => {
  const base = buildSampleStyleData();
  const bare: StyleData = {
    ...base,
    carton: { ...base.carton, assortEan: "0000000000000", perSize: [] },
  };
  const reps = repetitionStyles(bare, "cartonEan");
  assert.equal(reps.length, 1);
  assert.equal(reps[0].isAssortment, undefined);
});

test("per-size customerItemNo/description narrow with the repetition row", () => {
  const base = buildSampleStyleData();
  const s: StyleData = {
    ...base,
    sizes: [
      { label: "XS", ean13: "" },
      { label: "S", ean13: "" },
    ],
    eanVariants: undefined,
    customerItemNo: "XS: 7307204, S: 7307214",
    description: "XS: HIPSTER 2PK ROSA XS, S: HIPSTER 2PK ROSA S,",
  };
  const reps = repetitionStyles(s, "size");
  assert.equal(reps.length, 2);
  assert.equal(reps[0].customerItemNo, "7307204");
  assert.equal(reps[0].description, "HIPSTER 2PK ROSA XS");
  assert.equal(reps[1].customerItemNo, "7307214");
  assert.equal(reps[1].description, "HIPSTER 2PK ROSA S");
});

test("repeatBy 'cartonEan' rows narrow per-size text; assort row keeps the raw value", () => {
  const base = buildSampleStyleData();
  const perSize = base.carton.perSize!.slice(0, 2); // XS + S cartons
  const s: StyleData = {
    ...base,
    carton: { ...base.carton, perSize },
    customerItemNo: "XS: 7307204, S: 7307214",
    description: "plain description, no per-size entries",
  };
  const reps = repetitionStyles(s, "cartonEan");
  assert.equal(reps.length, 3); // 2 cartons + assort
  assert.equal(reps[0].customerItemNo, "7307204");
  assert.equal(reps[1].customerItemNo, "7307214");
  // No size anchors → description untouched on every row.
  assert.equal(reps[0].description, s.description);
  // The assort row is whole-style — raw list preserved.
  assert.equal(reps[2].isAssortment, true);
  assert.equal(reps[2].customerItemNo, s.customerItemNo);
});

test("single-value customerItemNo unchanged by per-size repeat", () => {
  const base = buildSampleStyleData();
  const s: StyleData = { ...base, customerItemNo: "223609" };
  for (const rep of repetitionStyles(s, "size")) {
    assert.equal(rep.customerItemNo, "223609");
  }
});
