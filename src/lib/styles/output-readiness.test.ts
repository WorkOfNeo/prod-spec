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
// A layout with a per-OUTPUT generation rule (Output Builder → Settings):
// "only generate for shoes". Needs no fields, so readiness turns purely on
// the rule.
const SHOE_ONLY_VARIANT = "layout:test-shoe-sticker";

// Minimal Output Builder-shaped variants: a per-carton repeat (same
// requiredFields gate as the coded one, but perRowCartonEan on), and the
// shoes-only sticker.
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
  {
    key: SHOE_ONLY_VARIANT,
    docType: "STICKER",
    name: "Shoe barcode sticker",
    description: "Test fixture — generate only for shoes",
    requiredFields: [],
    defaultWidthMm: 40,
    defaultHeightMm: 20,
    generationRules: [
      { field: "productGroup", op: "contains", keywords: ["shoes"], mode: "include" },
    ],
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
// Per-OUTPUT generation rules ride on the variant, so they apply even when the
// caller passes no doc-type rule map — the case every rerun/enqueue path hits.
// ---------------------------------------------------------------------------

function stickerReadiness(productGroup: string) {
  const style = styleWith(
    {
      rawData: {
        id: "1",
        name: "TEST1",
        column_values: [{ id: "manual.productGroup", type: "text", text: productGroup, value: null }],
      },
    },
    SHOE_ONLY_VARIANT,
  );
  const r = outputReadinessForStyle(style).find((o) => o.variantKey === SHOE_ONLY_VARIANT);
  assert.ok(r, "sticker output present in readiness");
  return r;
}

test("output rule 'only for shoes' — a shoe style generates", () => {
  const r = stickerReadiness("Kids Shoes");
  assert.equal(r.excluded, undefined);
  assert.equal(r.ready, true);
});

test("output rule 'only for shoes' — anything else is excluded, with the reason", () => {
  const r = stickerReadiness("Socks");
  assert.equal(r.excluded, true);
  // The output's own rule names the OUTPUT, not its document type.
  assert.equal(
    r.exclusionReason,
    "Not generated — Product group doesn’t contain “shoes” (Shoe barcode sticker rule)",
  );
});
