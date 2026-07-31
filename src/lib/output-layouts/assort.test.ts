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
let evaluateCalcForStyle: typeof import("./tokens").evaluateCalcForStyle;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;
let applyFieldOverrides: typeof import("../pdf/pins").applyFieldOverrides;
let readPinnableField: typeof import("../pdf/pins").readPinnableField;
let ASSORT: string;

before(async () => {
  ({ repetitionStyles, barcodeSymbology } = await import("./render"));
  ({ resolveBarcodeValue, resolveTextToken, evaluateCalcForStyle } = await import("./tokens"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
  ({ applyFieldOverrides, readPinnableField } = await import("../pdf/pins"));
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

test("per-size '=' carton-qty list → {{qtyPerCarton}} resolves the row's qty", () => {
  const base = buildSampleStyleData();
  const s: StyleData = {
    ...base,
    sizes: [
      { label: "XS", ean13: "" },
      { label: "S", ean13: "" },
    ],
    eanVariants: undefined,
    // The list doesn't parse as a number → outerVE 0, raw kept verbatim.
    cartonQtyRaw: "XS=1040, S=1050",
    carton: { ...base.carton, outerVE: 0 },
  };
  const reps = repetitionStyles(s, "size");
  assert.equal(reps.length, 2);
  assert.equal(resolveTextToken(reps[0], "qtyPerCarton"), "1040");
  assert.equal(resolveTextToken(reps[1], "qtyPerCarton"), "1050");
});

test("plain numeric carton qty → outerVE wins, repeat leaves it alone", () => {
  const base = buildSampleStyleData();
  const s: StyleData = {
    ...base,
    cartonQtyRaw: "48",
    carton: { ...base.carton, outerVE: 48 },
  };
  for (const rep of repetitionStyles(s, "size")) {
    assert.equal(resolveTextToken(rep, "qtyPerCarton"), "48");
  }
});

// A "Solid - N / Assort - M" split follows the repetition row automatically:
// the size cartons take Solid, the assort master carton takes Assort — for
// both the plain token and sum(qtyPerCarton).
function splitStyle(): StyleData {
  const base = buildSampleStyleData();
  return {
    ...base,
    cartonQtyRaw: "Solid - 5 / Assort - 8",
    carton: { ...base.carton, outerVE: 0, perSize: base.carton.perSize!.slice(0, 2) },
  };
}

test("split carton qty · cartonEan repeat → size rows Solid, assort row Assort", () => {
  const reps = repetitionStyles(splitStyle(), "cartonEan");
  const assort = reps.filter((r) => r.isAssortment);
  const solid = reps.filter((r) => !r.isAssortment);
  assert.ok(solid.length >= 1 && assort.length === 1);
  for (const r of solid) assert.equal(resolveTextToken(r, "qtyPerCarton"), "5");
  assert.equal(resolveTextToken(assort[0], "qtyPerCarton"), "8");
  // sum(qtyPerCarton) (single style → base only) tracks the row too.
  for (const r of solid) assert.equal(evaluateCalcForStyle("sum(qtyPerCarton)", r), "5");
  assert.equal(evaluateCalcForStyle("sum(qtyPerCarton)", assort[0]), "8");
});

test("split carton qty · standalone (no assort context) → Solid", () => {
  assert.equal(resolveTextToken(splitStyle(), "qtyPerCarton"), "5");
  assert.equal(evaluateCalcForStyle("sum(qtyPerCarton)", splitStyle()), "5");
});

test("explicit :solid / :assort override the row on a split value", () => {
  const reps = repetitionStyles(splitStyle(), "cartonEan");
  const assort = reps.find((r) => r.isAssortment)!;
  const solid = reps.find((r) => !r.isAssortment)!;
  assert.equal(resolveTextToken(assort, "qtyPerCarton", "solid"), "5");
  assert.equal(resolveTextToken(solid, "qtyPerCarton", "assort"), "8");
});

test("multi-style assort carton → sum(qtyPerCarton) adds each style's Assort", () => {
  const base = splitStyle();
  const s: StyleData = {
    ...base,
    multipleStyles: true,
    // Sibling carries its own split; on the assort carton it must contribute
    // its Assort (10), not its Solid (7).
    siblings: [
      {
        id: "sib",
        styleNumber: "X2",
        styleName: "",
        description: "",
        customerItemNo: "",
        colourName: "",
        colourCode: "",
        sizes: "",
        sizeRange: "",
        qtyPerCarton: "7",
        qtyPerCartonRaw: "Solid - 7 / Assort - 10",
        cartonEan: "",
        ean13: "",
      },
    ],
  };
  const assort = repetitionStyles(s, "cartonEan").find((r) => r.isAssortment)!;
  assert.equal(evaluateCalcForStyle("sum(qtyPerCarton)", assort), "18"); // 8 + 10
});

// ---------------------------------------------------------------------------
// The inner/outer PACK PAIR — the other axis a carton-qty cell can carry.
// "Solid= 5/20" is 5 per inner box, 20 per outer carton; bare {{qtyPerCarton}}
// takes the first number, so a layout printing it on an "Outer box" line is a
// box level off. :inner / :outer name the level.
// ---------------------------------------------------------------------------

function pairStyle(raw: string): StyleData {
  const base = buildSampleStyleData();
  return { ...base, cartonQtyRaw: raw, carton: { ...base.carton, outerVE: 0 } };
}

test(":inner / :outer split a labelled pack pair", () => {
  const s = pairStyle("Solid= 5/20");
  assert.equal(resolveTextToken(s, "qtyPerCarton", "inner"), "5");
  assert.equal(resolveTextToken(s, "qtyPerCarton", "outer"), "20");
  // Bare keeps taking the first number — unchanged behaviour.
  assert.equal(resolveTextToken(s, "qtyPerCarton"), "5");
});

test(":inner / :outer split a bare pack pair", () => {
  assert.equal(resolveTextToken(pairStyle("6/18"), "qtyPerCarton", "inner"), "6");
  assert.equal(resolveTextToken(pairStyle("6/18"), "qtyPerCarton", "outer"), "18");
  // Equal levels are still a pair.
  assert.equal(resolveTextToken(pairStyle("8/8"), "qtyPerCarton", "outer"), "8");
  assert.equal(resolveTextToken(pairStyle("30/30"), "qtyPerCarton", "inner"), "30");
});

test(":inner / :outer on a NON-pair fall through instead of blanking", () => {
  // One number serves both box levels.
  const plain = buildSampleStyleData();
  const ve = String(plain.carton.outerVE);
  assert.equal(resolveTextToken(plain, "qtyPerCarton", "inner"), ve);
  assert.equal(resolveTextToken(plain, "qtyPerCarton", "outer"), ve);
  // A Solid/Assort split is the OTHER axis — :outer must not eat its slash.
  assert.equal(resolveTextToken(splitStyle(), "qtyPerCarton", "outer"), "5");
  // A "(5+5)=10" total is two sub-styles, not a pair — left verbatim.
  const total = pairStyle("KH10058 A+ KH10058 C (5+5)=10");
  assert.equal(resolveTextToken(total, "qtyPerCarton", "outer"), "KH10058 A+ KH10058 C (5+5)=10");
});

test("a reviewer's pinned pack pair still splits by level", () => {
  const pinned = applyFieldOverrides(buildSampleStyleData(), { cartonQty: "5/20" });
  assert.equal(resolveTextToken(pinned, "qtyPerCarton", "inner"), "5");
  assert.equal(resolveTextToken(pinned, "qtyPerCarton", "outer"), "20");
});

// ---------------------------------------------------------------------------
// A reviewer's inline "Carton qty" edit has to beat the raw column text. The
// pin used to write only carton.outerVE, which {{qtyPerCarton}} never reads
// when a raw cell is present — so on exactly the styles worth correcting (a
// Solid/Assort split, a per-size list) the edit silently did nothing and the
// editor pre-filled blank.
// ---------------------------------------------------------------------------

test("cartonQty pin pre-fills the number that PRINTS, not the numeric parse", () => {
  // Split cell: outerVE is 0, so the old read showed "" next to a PDF saying 5.
  assert.equal(readPinnableField(splitStyle(), "cartonQty"), "5");
  const assort = repetitionStyles(splitStyle(), "cartonEan").find((r) => r.isAssortment)!;
  assert.equal(readPinnableField(assort, "cartonQty"), "8");
  // A plain numeric cell still reads back as its number.
  const plain = buildSampleStyleData();
  assert.equal(readPinnableField(plain, "cartonQty"), String(plain.carton.outerVE));
});

test("cartonQty pin overrides a Solid/Assort split on every row", () => {
  const pinned = applyFieldOverrides(splitStyle(), { cartonQty: "12" });
  assert.equal(resolveTextToken(pinned, "qtyPerCarton"), "12");
  // The split is gone, so the assort master carton takes the pinned value too
  // — the reviewer forced ONE number for this output.
  for (const rep of repetitionStyles(pinned, "cartonEan")) {
    assert.equal(resolveTextToken(rep, "qtyPerCarton"), "12");
  }
  // Calc aggregates follow the same resolver, so sum() can't disagree.
  assert.equal(evaluateCalcForStyle("sum(qtyPerCarton)", pinned), "12");
});

test("cartonQty pin may itself be a split — narrowing still applies", () => {
  const pinned = applyFieldOverrides(buildSampleStyleData(), {
    cartonQty: "Solid - 6 / Assort - 9",
  });
  const reps = repetitionStyles(pinned, "cartonEan");
  assert.equal(resolveTextToken(reps.find((r) => r.isAssortment)!, "qtyPerCarton"), "9");
  assert.equal(resolveTextToken(reps.find((r) => !r.isAssortment)!, "qtyPerCarton"), "6");
});

test("cartonQty pin beats a per-size list (no size anchor → verbatim)", () => {
  const base = buildSampleStyleData();
  const perSize: StyleData = {
    ...base,
    cartonQtyRaw: "S=10,M=12,L=14",
    carton: { ...base.carton, outerVE: 0 },
  };
  // Un-pinned, each size row narrows to its own qty…
  const rows = repetitionStyles(perSize, "size");
  assert.ok(new Set(rows.map((r) => resolveTextToken(r, "qtyPerCarton"))).size > 1);
  // …pinned, every row prints the forced number.
  for (const rep of repetitionStyles(applyFieldOverrides(perSize, { cartonQty: "20" }), "size")) {
    assert.equal(resolveTextToken(rep, "qtyPerCarton"), "20");
  }
});

test("cartonQty pin with no raw cell keeps its existing meaning", () => {
  // The 125 overrides already stored in prod are all on styles with an empty
  // carton-qty cell — they printed via outerVE and must keep printing the same.
  const base = buildSampleStyleData();
  const noRaw: StyleData = { ...base, cartonQtyRaw: undefined, carton: { ...base.carton, outerVE: 0 } };
  const pinned = applyFieldOverrides(noRaw, { cartonQty: "40" });
  assert.equal(resolveTextToken(pinned, "qtyPerCarton"), "40");
  assert.equal(pinned.carton.outerVE, 40);
});

test("single-value customerItemNo unchanged by per-size repeat", () => {
  const base = buildSampleStyleData();
  const s: StyleData = { ...base, customerItemNo: "223609" };
  for (const rep of repetitionStyles(s, "size")) {
    assert.equal(rep.customerItemNo, "223609");
  }
});
