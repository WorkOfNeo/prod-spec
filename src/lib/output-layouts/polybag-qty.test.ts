import { test } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "@/lib/pdf/types";
import type { LayoutDef } from "./schema";
import { resolvePolybagQty } from "./polybag-qty";
import {
  applyConditionalsForStyle,
  layoutReadinessColumns,
  resolveTextToken,
  staticRequiredColumns,
} from "./tokens";

// {{polybagQty}} lifts the pieces-per-polybag count out of Monday's Trims
// column, so the solid polybag sticker can print a quantity field only when
// more than one piece is packed. The Trims cells below are live values.

const TOKMANNI_TRIMS =
  "Price sticker, Solid polybag- 5 Pcs / Polybag, Solid Polybag sticker, Super dry- 5g for solid, Carton Marking";

const QTY_LINE = '{{if polybagQty != ""}}QTY: {{polybagQty}} PCS{{endif}}';

function makeStyle(over: Partial<StyleData>): StyleData {
  return {
    styleName: "Base Style",
    styleNumber: "IL0001",
    customerName: "Tokmanni Oy",
    businessArea: "PL",
    composition: [],
    productNameTranslations: [],
    washSymbols: [],
    sizes: [],
    carton: { klNumber: "", supplierNumber: "", lot: "", outerVE: 0, ean13: "" },
    ...over,
  } as StyleData;
}

function defWithLines(lines: string[]): LayoutDef {
  return {
    pages: [{ blocks: [{ lines }] }],
  } as unknown as LayoutDef;
}

test("reads the count from the live solid polybag entries", () => {
  assert.equal(resolvePolybagQty(TOKMANNI_TRIMS), "5");
  assert.equal(resolvePolybagQty("Solid Polybag - 2 Pcs/ Polybag, Hangtag"), "2");
});

test("one piece resolves empty — the sticker needs no qty field", () => {
  assert.equal(resolvePolybagQty("1 pc individual polybag for solid, Polybag Sticker"), "");
});

test("a master polybag's count is not the solid polybag's", () => {
  assert.equal(resolvePolybagQty("10 pcs/master polybag, Polybag Sticker"), "");
  assert.equal(resolvePolybagQty("10 pcs/master polybag, Solid polybag- 5 Pcs / Polybag"), "5");
});

test("no count, no polybag entry or no Trims at all resolve empty", () => {
  assert.equal(resolvePolybagQty("Solid Polybag sticker, Individual Polybag for solid"), "");
  assert.equal(resolvePolybagQty("Hangtag, Carton Marking"), "");
  assert.equal(resolvePolybagQty(""), "");
  assert.equal(resolvePolybagQty(undefined), "");
});

test("{{polybagQty}} resolves off the style's Trims text", () => {
  assert.equal(resolveTextToken(makeStyle({ trimsRaw: TOKMANNI_TRIMS }), "polybagQty"), "5");
  assert.equal(resolveTextToken(makeStyle({}), "polybagQty"), "");
});

test("the documented conditional prints the field only above one piece", () => {
  const five = applyConditionalsForStyle(QTY_LINE, makeStyle({ trimsRaw: TOKMANNI_TRIMS }));
  assert.equal(five, "QTY: {{polybagQty}} PCS");

  const one = applyConditionalsForStyle(
    QTY_LINE,
    makeStyle({ trimsRaw: "1 pc individual polybag for solid" }),
  );
  assert.equal(one, "");
});

test("never gates readiness — a one-piece style is ready without it", () => {
  const def = defWithLines(["{{polybagQty}}", QTY_LINE]);
  assert.deepEqual(staticRequiredColumns(def), []);
  assert.deepEqual(layoutReadinessColumns(def, () => ""), []);
});
