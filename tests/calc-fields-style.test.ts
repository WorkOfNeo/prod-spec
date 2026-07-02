// Calculated fields ({{= …}}) against REAL StyleData — the tokens.ts
// wiring: sum() across the base style + active siblings behind the
// multi-style gate, sibling references coercing to 0, unresolved gaps,
// readiness columns, and composition with {{if …}} conditionals.
//
// tokens.ts transitively imports @/lib/db (which throws without a
// DATABASE_URL at import time), so this runs under the module-mock script:
//   node --experimental-test-module-mocks --import tsx --test "tests/**/*.test.ts"
import { test, mock, before } from "node:test";
import assert from "node:assert/strict";

mock.module("@/lib/db", { namedExports: { db: {} } });

type TokensModule = typeof import("@/lib/output-layouts/tokens");
type SchemaModule = typeof import("@/lib/output-layouts/schema");
type SampleModule = typeof import("@/lib/pdf/sample-data");
type RenderModule = typeof import("@/lib/output-layouts/render");
type StyleData = import("@/lib/pdf/types").StyleData;

let tokens: TokensModule;
let schema: SchemaModule;
let sample: SampleModule;
let render: RenderModule;

before(async () => {
  tokens = await import("@/lib/output-layouts/tokens");
  schema = await import("@/lib/output-layouts/schema");
  sample = await import("@/lib/pdf/sample-data");
  render = await import("@/lib/output-layouts/render");
});

// The sample style with a known carton qty, optionally carrying a sibling
// pool and the multi-style flag (the carton-dialog print state).
function style(overrides: Partial<StyleData> = {}): StyleData {
  const base = sample.buildSampleStyleData();
  base.carton.outerVE = 48;
  return { ...base, ...overrides };
}

function sibling(id: string, qty: string) {
  return {
    id,
    styleNumber: `STY-${id}`,
    styleName: `Sibling ${id}`,
    description: "",
    customerItemNo: "",
    colourName: "",
    colourCode: "",
    sizes: "",
    sizeRange: "",
    qtyPerCarton: qty,
    cartonEan: "",
    ean13: "",
  };
}

test("sum(qtyPerCarton) — standard generation = the base style's own qty", () => {
  assert.equal(tokens.evaluateCalcForStyle("sum(qtyPerCarton)", style()), "48");
});

test("sum(qtyPerCarton) — multi-style print sums the picked siblings", () => {
  const s = style({
    multipleStyles: true,
    siblings: [sibling("a", "24"), sibling("b", "12")],
  });
  assert.equal(tokens.evaluateCalcForStyle("sum(qtyPerCarton)", s), "84");
});

test("sum(qtyPerCarton) — a sibling POOL without the multi-style flag stays base-only", () => {
  // The pool is always pre-fetched on StyleData; without the gate the
  // aggregate must not leak siblings into standard generation.
  const s = style({ siblings: [sibling("a", "24")] });
  assert.equal(tokens.evaluateCalcForStyle("sum(qtyPerCarton)", s), "48");
});

test("direct style2 reference — adds when present, 0 when absent, never fails", () => {
  const expr = "qtyPerCarton + style2QtyPerCarton";
  const withSib = style({ multipleStyles: true, siblings: [sibling("a", "24")] });
  assert.equal(tokens.evaluateCalcForStyle(expr, withSib), "72");
  assert.equal(tokens.evaluateCalcForStyle(expr, style()), "48");
});

test("missing base carton qty — unresolved, and listed as the layout's amber gap", () => {
  const s = style();
  s.carton.outerVE = 0; // {{qtyPerCarton}} resolves ""
  assert.equal(tokens.evaluateCalcForStyle("sum(qtyPerCarton)", s), null);

  const def = schema.parseLayoutDef({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 100,
        heightMm: 75,
        blocks: [
          {
            rect: { col: 0, row: 0, colSpan: 6, rowSpan: 2 },
            lines: ["Total: {{= sum(qtyPerCarton) }} PCS"],
          },
        ],
      },
    ],
  });
  assert.deepEqual(tokens.unresolvedTokens(def, s), ["{{= sum(qtyPerCarton) }}"]);
  // With the qty present the gap clears.
  assert.deepEqual(tokens.unresolvedTokens(def, style()), []);
  // And readiness gates on the carton-qty column like the bare token would.
  assert.ok(tokens.staticRequiredColumns(def).includes("cartonQty"));
});

test("calc inside {{if}} — only the taken branch evaluates / gates readiness", () => {
  const line =
    "{{if multipleStyles == true}}Total: {{= sum(qtyPerCarton) }} PCS{{else}}Qty: {{qtyPerCarton}} PCS{{endif}}";
  const def = schema.parseLayoutDef({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 100,
        heightMm: 75,
        blocks: [{ rect: { col: 0, row: 0, colSpan: 6, rowSpan: 2 }, lines: [line] }],
      },
    ],
  });

  // Single-style + missing qty: the CALC branch is not taken, so the calc
  // is never an amber gap — only the plain token in the else-branch is.
  const gapped = style();
  gapped.carton.outerVE = 0;
  assert.deepEqual(tokens.unresolvedTokens(def, gapped), ["{{qtyPerCarton}}"]);

  // Multi-style + missing qty: now the calc IS the taken branch.
  const gappedMulti = style({ multipleStyles: true, siblings: [sibling("a", "24")] });
  gappedMulti.carton.outerVE = 0;
  assert.deepEqual(tokens.unresolvedTokens(def, gappedMulti), ["{{= sum(qtyPerCarton) }}"]);

  // Branch-aware readiness still needs cartonQty on either branch.
  const cols = tokens.layoutReadinessColumns(def, () => "");
  assert.ok(cols.includes("cartonQty"));
});

test("count(styleNumber) — styles on the box", () => {
  const s = style({ multipleStyles: true, siblings: [sibling("a", "24"), sibling("b", "12")] });
  assert.equal(tokens.evaluateCalcForStyle("count(styleNumber)", s), "3");
  assert.equal(tokens.evaluateCalcForStyle("count(styleNumber)", style()), "1");
});

// ── The real renderer, end to end ────────────────────────────────────────

const RENDER_DEF = {
  pages: [
    {
      id: "p1",
      title: "",
      widthMm: 100,
      heightMm: 75,
      blocks: [
        {
          rect: { col: 0, row: 0, colSpan: 8, rowSpan: 4 },
          lines: [
            "Total: {{= sum(qtyPerCarton) }} PCS",
            "{{if multipleStyles == true}}Styles: {{= count(styleNumber) }}{{endif}}",
          ],
        },
      ],
    },
  ],
};

test("renderLayoutHtml — calc values print; the {{if}}-gated calc line follows its branch", async () => {
  const def = schema.parseLayoutDef(RENDER_DEF);

  const single = await render.renderLayoutHtml(def, style(), { mode: "production" });
  assert.match(single, /Total: 48 PCS/);
  assert.doesNotMatch(single, /Styles:/);

  const multi = await render.renderLayoutHtml(
    def,
    style({ multipleStyles: true, siblings: [sibling("a", "24"), sibling("b", "12")] }),
    { mode: "production" },
  );
  assert.match(multi, /Total: 84 PCS/);
  assert.match(multi, /Styles: 3/);
});

test("renderLayoutHtml — unresolved calc is an amber chip in preview, silent in production", async () => {
  const def = schema.parseLayoutDef(RENDER_DEF);
  const gapped = style();
  gapped.carton.outerVE = 0;

  // (.ol-miss always appears in the stylesheet — assert on the chip markup.)
  const preview = await render.renderLayoutHtml(def, gapped, { mode: "preview" });
  assert.match(preview, /<span class="ol-miss">= sum\(qtyPerCarton\)\?<\/span>/);

  const production = await render.renderLayoutHtml(def, gapped, { mode: "production" });
  assert.doesNotMatch(production, /<span class="ol-miss">/);
  assert.doesNotMatch(production, /sum\(qtyPerCarton\)/);
});
