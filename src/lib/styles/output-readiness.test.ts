import { test } from "node:test";
import assert from "node:assert/strict";
import { outputReadinessForStyle, type ReadinessStyle } from "./output-readiness";
import { setDynamicVariants } from "@/lib/pdf/template-registry";

// ---------------------------------------------------------------------------
// The cartonEan readiness gate must agree with the renderer, and the renderer
// treats the two layout shapes differently:
//
//   • PER-ROW carton (repeatBy "ean" / "cartonEan", variant.perRowCartonEan):
//     each repetition row binds its OWN carton from style_eans.cartonEan, so a
//     style whose buyer filled the per-size "Carton Barcode number 1" lines but
//     no "Assort -" line (⇒ Style.cartonEan NULL, by design) IS renderable and
//     must not read "awaiting data".
//   • STYLE-LEVEL carton (repeatBy "none", and every coded variant): prints the
//     single Style.cartonEan. Per-size rows can't stand in — the output would
//     ship with a BLANK barcode — so it must stay "awaiting data".
//
// The coded Netto carton variant is the style-level case (it reads
// style.carton.ean13 directly); PER_ROW_VARIANT below stands in for a layout
// with a per-carton repeat.
// ---------------------------------------------------------------------------

const CARTON_VARIANT = "netto-dk-privatelabel-carton-marking";
const PER_ROW_VARIANT = "layout:test-per-carton";

// A minimal Output Builder-shaped variant with a per-carton repeat — the same
// requiredFields gate as the coded one, but perRowCartonEan on.
setDynamicVariants([
  {
    key: PER_ROW_VARIANT,
    docType: "CARTON_MARKING",
    name: "Test per-carton layout",
    description: "Test fixture — per-carton repeat",
    requiredFields: ["cartonEan"],
    defaultWidthMm: 105,
    defaultHeightMm: 148,
    perRowCartonEan: true,
    render: async () => "",
  },
]);

function styleWith(over: Partial<ReadinessStyle>, variantKey = CARTON_VARIANT): ReadinessStyle {
  return {
    // Manual columns satisfy the variant's other requirements (cartonQty,
    // description; empty deliveryTerm ⇒ DDP branch ⇒ poNumber, injected from
    // style.poNumber below).
    rawData: {
      id: "1",
      name: "TEST1",
      column_values: [
        { id: "manual.cartonQty", type: "text", text: "24", value: null },
        { id: "manual.description", type: "text", text: "T-shirt", value: null },
      ],
    },
    poNumber: "C-PO00001",
    customer: { config: {} },
    prodSpec: {
      outputs: [{ variantKey, enabled: true, widthMm: 105, heightMm: 148 }],
      columnMapping: {},
    },
    ...over,
  };
}

function cartonReadiness(style: ReadinessStyle, variantKey = CARTON_VARIANT) {
  const r = outputReadinessForStyle(style).find((o) => o.variantKey === variantKey);
  assert.ok(r, "carton output present in readiness");
  return r;
}

test("no carton anywhere → cartonEan missing, not ready", () => {
  const r = cartonReadiness(styleWith({ eans: [], cartonEan: null }));
  assert.equal(r.ready, false);
  assert.ok(r.missing.some((m) => m.field === "cartonEan"));
});

const PER_SIZE_ONLY: Partial<ReadinessStyle> = {
  cartonEan: null,
  eans: [
    { size: "M/L", ean13: "7070001349999", cartonEan: "7070001349999" },
    { size: "XL/XXL", ean13: "7070001350001", cartonEan: "7070001350001" },
  ],
};

test("per-size cartons only + PER-ROW carton repeat → ready", () => {
  const r = cartonReadiness(styleWith(PER_SIZE_ONLY, PER_ROW_VARIANT), PER_ROW_VARIANT);
  assert.equal(r.ready, true);
  assert.ok(!r.missing.some((m) => m.field === "cartonEan"));
});

// The regression this guard exists for: CO60053 (Ge-kås) had five per-size
// cartons from Monday and no assort line, and its non-repeating carton marking
// generated anyway — with an empty {{barcode:cartonEan}}.
test("per-size cartons only + STYLE-LEVEL carton output → still missing", () => {
  const r = cartonReadiness(styleWith(PER_SIZE_ONLY));
  assert.equal(r.ready, false);
  assert.ok(r.missing.some((m) => m.field === "cartonEan"));
});

test("blank per-size cartons don't count", () => {
  const r = cartonReadiness(
    styleWith({
      cartonEan: null,
      eans: [
        { size: "M/L", ean13: "7070001349999", cartonEan: "  " },
        { size: "XL/XXL", ean13: "7070001350001", cartonEan: null },
      ],
    }),
  );
  assert.equal(r.ready, false);
  assert.ok(r.missing.some((m) => m.field === "cartonEan"));
});

test("style-level carton (assort line) still satisfies on its own", () => {
  const r = cartonReadiness(styleWith({ cartonEan: "5701234567890", eans: [] }));
  assert.equal(r.ready, true);
});

// ---------------------------------------------------------------------------
// The unambiguous case: every size shares ONE carton, so there's no arbitrary
// pick to make — effectiveStyleItem injects it and even a style-level output
// resolves it. This is the ONLY way per-size cartons satisfy a non-repeating
// layout; the differing case above must stay blocked.
// ---------------------------------------------------------------------------

const ONE_SHARED_CARTON: Partial<ReadinessStyle> = {
  cartonEan: null,
  eans: [
    { size: "M/L", ean13: "7070001349999", cartonEan: "7070001353354" },
    { size: "XL/XXL", ean13: "7070001350001", cartonEan: "7070001353354" },
  ],
};

test("one carton shared by every size satisfies a STYLE-LEVEL output", () => {
  const r = cartonReadiness(styleWith(ONE_SHARED_CARTON));
  assert.equal(r.ready, true);
  assert.ok(!r.missing.some((m) => m.field === "cartonEan"));
});

test("one carton shared by every size also satisfies a per-row output", () => {
  const r = cartonReadiness(styleWith(ONE_SHARED_CARTON, PER_ROW_VARIANT), PER_ROW_VARIANT);
  assert.equal(r.ready, true);
});

// Hidden rows never print, so they can't decide the style's carton either.
// Readiness has to judge the same visible set buildStyleData renders from.
test("an excluded row's differing carton doesn't spoil the shared value", () => {
  const r = cartonReadiness(
    styleWith({
      cartonEan: null,
      eans: [
        { size: "M/L", ean13: "7070001349999", cartonEan: "7070001353354" },
        { size: "XL/XXL", ean13: "7070001350001", cartonEan: "7070001353354" },
        { size: "3XL", ean13: "7070001350018", cartonEan: "5706323374662", excluded: true },
      ],
    }),
  );
  assert.equal(r.ready, true);
});

test("an excluded row's carton can't satisfy the gate on its own", () => {
  const r = cartonReadiness(
    styleWith({
      cartonEan: null,
      eans: [{ size: "M/L", ean13: "7070001349999", cartonEan: "7070001353354", excluded: true }],
    }),
  );
  assert.equal(r.ready, false);
  assert.ok(r.missing.some((m) => m.field === "cartonEan"));
});
