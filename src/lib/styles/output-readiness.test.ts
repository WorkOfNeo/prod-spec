import { test } from "node:test";
import assert from "node:assert/strict";
import { outputReadinessForStyle, type ReadinessStyle } from "./output-readiness";

// ---------------------------------------------------------------------------
// The cartonEan readiness gate must agree with the renderer: repeatBy=
// "cartonEan" splits on the PER-SIZE cartons (style_eans.cartonEan), so a
// style whose buyer filled the per-size "Carton Barcode number 1" lines but
// no "Assort -" line (⇒ Style.cartonEan NULL, by design) is renderable and
// must not read "awaiting data". Uses the coded Netto carton variant, whose
// static gate requires cartonEan.
// ---------------------------------------------------------------------------

const CARTON_VARIANT = "netto-dk-privatelabel-carton-marking";

function styleWith(over: Partial<ReadinessStyle>): ReadinessStyle {
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
      outputs: [{ variantKey: CARTON_VARIANT, enabled: true, widthMm: 105, heightMm: 148 }],
      columnMapping: {},
    },
    ...over,
  };
}

function cartonReadiness(style: ReadinessStyle) {
  const r = outputReadinessForStyle(style).find((o) => o.variantKey === CARTON_VARIANT);
  assert.ok(r, "carton output present in readiness");
  return r;
}

test("no carton anywhere → cartonEan missing, not ready", () => {
  const r = cartonReadiness(styleWith({ eans: [], cartonEan: null }));
  assert.equal(r.ready, false);
  assert.ok(r.missing.some((m) => m.field === "cartonEan"));
});

test("per-size cartons only (no assort line ⇒ Style.cartonEan NULL) → ready", () => {
  const r = cartonReadiness(
    styleWith({
      cartonEan: null,
      eans: [
        { size: "M/L", ean13: "7070001349999", cartonEan: "7070001349999" },
        { size: "XL/XXL", ean13: "7070001350001", cartonEan: "7070001350001" },
      ],
    }),
  );
  assert.equal(r.ready, true);
  assert.ok(!r.missing.some((m) => m.field === "cartonEan"));
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
