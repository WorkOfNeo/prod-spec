import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALC_RE,
  calcsInLine,
  evaluateCalc,
  fieldsInCalcExpression,
  formatCalcResult,
  parseCalcExpression,
  parseNumericValue,
  validateCalcExpression,
  validateLineCalcs,
  type CalcFieldCtx,
} from "./calc";

// A context standing in for the StyleData-backed one in tokens.ts:
// `fields` maps directly referenced keys to raw values; `slots` gives the
// per-carton values an aggregate walks (base first). Suffix is ignored —
// these tests exercise one field at a time.
function ctx(fields: Record<string, string>, slots: string[] = []): CalcFieldCtx {
  return {
    field: (key) => fields[key] ?? "",
    aggregate: () => ({ base: slots[0] ?? "", siblings: slots.slice(1) }),
  };
}

function evalExpr(expr: string, c: CalcFieldCtx): string | null {
  const parsed = parseCalcExpression(expr);
  assert.ok(parsed.ast, `parse failed: ${parsed.error}`);
  return evaluateCalc(parsed.ast, c);
}

// ── Parsing ──────────────────────────────────────────────────────────────

test("parse — precedence and parentheses", () => {
  assert.equal(evalExpr("2 + 3 * 4", ctx({})), "14");
  assert.equal(evalExpr("(2 + 3) * 4", ctx({})), "20");
  assert.equal(evalExpr("-3 + 10", ctx({})), "7");
  assert.equal(evalExpr("10 / 4", ctx({})), "2.5");
});

test("parse — errors are precise and non-throwing", () => {
  assert.match(parseCalcExpression("").error ?? "", /empty calculation/);
  assert.match(parseCalcExpression("2 +").error ?? "", /ends unexpectedly/);
  assert.match(parseCalcExpression("(2 + 3").error ?? "", /missing "\)"/);
  assert.match(parseCalcExpression("2 3").error ?? "", /unexpected "3"/);
  assert.match(parseCalcExpression("qty per").error ?? "", /unexpected "per"/);
  assert.match(parseCalcExpression("total(qtyPerCarton)").error ?? "", /unknown function/);
  assert.match(parseCalcExpression("sum(2)").error ?? "", /takes a field name/);
  assert.match(parseCalcExpression("round(x, 9)").error ?? "", /between 0 and 6/);
  assert.match(parseCalcExpression("2 € 3").error ?? "", /unexpected "€"/);
});

// ── Field references ─────────────────────────────────────────────────────

test("fields — base field empty or non-numeric → unresolved", () => {
  assert.equal(evalExpr("qtyPerCarton * 2", ctx({ qtyPerCarton: "48" })), "96");
  assert.equal(evalExpr("qtyPerCarton * 2", ctx({})), null);
  assert.equal(evalExpr("qtyPerCarton * 2", ctx({ qtyPerCarton: "n/a" })), null);
});

test("fields — sibling slot references coerce to 0 when empty", () => {
  // "IF style two then we add this — and it should not fail if not."
  const both = ctx({ qtyPerCarton: "48", style2QtyPerCarton: "24" });
  const alone = ctx({ qtyPerCarton: "48" });
  assert.equal(evalExpr("qtyPerCarton + style2QtyPerCarton", both), "72");
  assert.equal(evalExpr("qtyPerCarton + style2QtyPerCarton", alone), "48");
  // Slot 1 is the base style itself — NOT optional.
  assert.equal(evalExpr("style1QtyPerCarton + 1", alone), null);
});

test("fields — numeric parsing tolerates units and comma decimals", () => {
  assert.equal(parseNumericValue("29.00 DKK"), 29);
  assert.equal(parseNumericValue("29,5"), 29.5);
  assert.equal(parseNumericValue("PCS"), null);
  assert.equal(evalExpr("price * 2", ctx({ price: "29.00 DKK" })), "58");
});

// ── Aggregates ───────────────────────────────────────────────────────────

test("sum — base + siblings, empty sibling slots skipped", () => {
  assert.equal(evalExpr("sum(qtyPerCarton)", ctx({}, ["48"])), "48");
  assert.equal(evalExpr("sum(qtyPerCarton)", ctx({}, ["48", "24", "12"])), "84");
  assert.equal(evalExpr("sum(qtyPerCarton)", ctx({}, ["48", "", "12"])), "60");
  // Missing BASE value is a real data gap → unresolved.
  assert.equal(evalExpr("sum(qtyPerCarton)", ctx({}, ["", "24"])), null);
});

test("count/min/max", () => {
  assert.equal(evalExpr("count(styleNumber)", ctx({}, ["A", "B", ""])), "2");
  assert.equal(evalExpr("count(styleNumber)", ctx({}, [""])), "0");
  assert.equal(evalExpr("min(qtyPerCarton)", ctx({}, ["48", "12"])), "12");
  assert.equal(evalExpr("max(qtyPerCarton)", ctx({}, ["48", "12"])), "48");
});

test("round and division by zero", () => {
  assert.equal(evalExpr("round(10 / 3, 1)", ctx({})), "3.3");
  assert.equal(evalExpr("round(10 / 3)", ctx({})), "3");
  assert.equal(evalExpr("1 / 0", ctx({})), null);
});

test("formatCalcResult — integers bare, fractions trimmed, float noise killed", () => {
  assert.equal(formatCalcResult(84), "84");
  assert.equal(formatCalcResult(4.5), "4.5");
  assert.equal(formatCalcResult(0.1 + 0.2), "0.3");
});

// ── Line helpers & the regex ─────────────────────────────────────────────

test("CALC_RE — extracts bodies, coexists with plain tokens on one line", () => {
  const line = "Total: {{= sum(qtyPerCarton) }} PCS ({{styleNumber}})";
  assert.deepEqual(calcsInLine(line), ["sum(qtyPerCarton)"]);
  // The calc match must not swallow the neighbouring plain token.
  const m = [...line.matchAll(new RegExp(CALC_RE.source, "g"))];
  assert.equal(m.length, 1);
  assert.equal(m[0][0], "{{= sum(qtyPerCarton) }}");
});

test("fieldsInCalcExpression — direct fields and canonical aggregate keys", () => {
  const { fields, aggregates } = fieldsInCalcExpression(
    "qtyPerCarton + style2QtyPerCarton + sum(QTYPERCARTON)",
  );
  assert.deepEqual(fields.sort(), ["qtyPerCarton", "style2QtyPerCarton"]);
  assert.deepEqual(aggregates, ["qtyPerCarton"]);
});

// ── Validation ───────────────────────────────────────────────────────────

test("validateCalcExpression — unknown / non-text / per-language fields rejected", () => {
  assert.deepEqual(validateCalcExpression("sum(qtyPerCarton) + 1"), []);
  assert.deepEqual(validateCalcExpression("qtyPerCarton + style2QtyPerCarton"), []);
  assert.match(validateCalcExpression("nope + 1")[0], /unknown field "nope"/);
  assert.match(validateCalcExpression("barcode + 1")[0], /is barcode/);
  assert.match(validateCalcExpression("composition + 1")[0], /per-language/);
  assert.match(validateCalcExpression("sum(colourway)")[0], /can't be aggregated/);
});

test("validateLineCalcs — every calc checked, unclosed {{= flagged", () => {
  assert.deepEqual(validateLineCalcs("Total: {{= sum(qtyPerCarton) }} PCS"), []);
  assert.match(validateLineCalcs("{{= sum( }}")[0], /takes a field name/);
  assert.match(validateLineCalcs("Total: {{= sum(qtyPerCarton)")[0], /unclosed/);
});
