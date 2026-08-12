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
// One rule-free variant per document type, standing in for the 181 real
// outputs. "Shoes ⇒ HangTag only" is expressed at DOC-TYPE scope, so these
// carry no rules of their own — exactly like the 58 static/legacy variants,
// which have nowhere to put one.
const BY_DOC_TYPE: Record<string, string> = {
  HANGTAG: "layout:test-hangtag",
  STICKER: "layout:test-sticker",
  CARE_LABEL: "layout:test-care-label",
  CARTON_MARKING: "layout:test-carton-marking",
  WASHCARE: "layout:test-washcare",
};

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
  ...Object.entries(BY_DOC_TYPE).map(([docType, key]) => ({
    key,
    docType,
    name: `Test ${docType}`,
    description: `Test fixture — rule-free ${docType}`,
    requiredFields: [],
    defaultWidthMm: 40,
    defaultHeightMm: 20,
    render: async () => "",
  })),
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

// ---------------------------------------------------------------------------
// "Product Group = Shoes ⇒ only the HangTag is created."
//
// Expressed as DOC-TYPE rule data, not code: one "never when Product group
// contains shoe" rule on each non-HANGTAG document type. Doc-type scope is the
// only scope that can carry this — per-OUTPUT rules live on
// LayoutSettings.rules, which only Output Builder layouts have, and 58 of the
// 181 live variants are static/legacy ones with nowhere to put one.
//
// The keyword is "shoe", not "shoes": the live Product Group taxonomy is free
// text and carries "Sneaker shoe" alongside "Shoes" / "Swim Shoes" / "Womens
// sports shoes". It is deliberately NOT "sneaker" or "slipper" — those would
// swallow the ~90 sneaker-sock / slipper-sock styles, which are socks.
// ---------------------------------------------------------------------------

const SHOES_HANGTAG_ONLY_RULES = Object.fromEntries(
  Object.keys(BY_DOC_TYPE)
    .filter((dt) => dt !== "HANGTAG")
    .map((dt) => [dt, [{ field: "productGroup", op: "contains" as const, keywords: ["shoe"] }]]),
);

const DOC_TYPE_LABELS: Record<string, string> = {
  STICKER: "Sticker",
  CARE_LABEL: "Care label",
  CARTON_MARKING: "Carton marking",
  WASHCARE: "Wash care",
};

// A style declaring one output of EVERY document type — the worst case the
// rule has to survive.
function everyDocTypeReadiness(productGroup: string) {
  const style: ReadinessStyle = {
    ...styleWith({}),
    rawData: {
      id: "1",
      name: "TEST1",
      column_values: [{ id: "manual.productGroup", type: "text", text: productGroup, value: null }],
    },
    prodSpec: {
      outputs: Object.values(BY_DOC_TYPE).map((variantKey) => ({
        variantKey,
        enabled: true,
        widthMm: 40,
        heightMm: 20,
      })),
      columnMapping: {},
    },
  };
  return outputReadinessForStyle(style, SHOES_HANGTAG_ONLY_RULES, DOC_TYPE_LABELS);
}

function generated(productGroup: string): string[] {
  return everyDocTypeReadiness(productGroup)
    .filter((o) => !o.excluded)
    .map((o) => o.variantKey);
}

for (const productGroup of ["Shoes", "Swim Shoes", "Womens sports shoes", "Sneaker shoe"]) {
  test(`Product group “${productGroup}” → the HangTag and nothing else`, () => {
    assert.deepEqual(generated(productGroup), [BY_DOC_TYPE.HANGTAG]);
  });
}

test("the four suppressed outputs each say why, naming their document type", () => {
  const excluded = everyDocTypeReadiness("Shoes").filter((o) => o.excluded);
  assert.equal(excluded.length, 4);
  assert.ok(
    excluded.every((o) => o.exclusionReason?.endsWith("rule)")),
    "every suppressed output carries a reason",
  );
  const sticker = excluded.find((o) => o.variantKey === BY_DOC_TYPE.STICKER);
  assert.equal(
    sticker?.exclusionReason,
    "Not generated — Product group contains “shoe” (Sticker rule)",
  );
});

// The out-of-scope guard: this must change nothing for any other product
// group. "Swim Shorts" / "sweat shorts" / "Shorty Set" are live values that
// contain "sho" — a sloppier keyword would silently kill their outputs.
for (const productGroup of ["Swim Shorts", "sweat shorts", "Shorty Set", "3-Pack Socks", "T-Shirt"]) {
  test(`Product group “${productGroup}” still generates all five outputs`, () => {
    assert.deepEqual(generated(productGroup).sort(), Object.values(BY_DOC_TYPE).sort());
  });
}
