import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "../pdf/types";
import { formatCompositionFibreLines } from "./composition";

process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let resolveTextToken: typeof import("./tokens").resolveTextToken;
let compositionLangsInDef: typeof import("./tokens").compositionLangsInDef;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;
let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;

before(async () => {
  ({ resolveTextToken, compositionLangsInDef } = await import("./tokens"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
  ({ LayoutDefSchema } = await import("./schema"));
});

const lines = (text: string) => formatCompositionFibreLines(text).split("\n");

// Every input below is a real live composition shape.

test("splits a space-separated fibre list — the common form", () => {
  assert.deepEqual(lines("95% Cotton 5% Elastane"), ["95% Cotton", "5% Elastane"]);
  assert.deepEqual(lines("57% Cotton 38% Polyester 5% Elastane"), [
    "57% Cotton",
    "38% Polyester",
    "5% Elastane",
  ]);
});

test("splits a comma-separated list and drops the stranded comma", () => {
  assert.deepEqual(lines("82% Acrylic, 17% Polyester, 1% Elastane"), [
    "82% Acrylic",
    "17% Polyester",
    "1% Elastane",
  ]);
});

test("a part label stays with its own first fibre", () => {
  assert.deepEqual(lines("Outer: 91% Polyester 9% Elastane Inner: 100% Polyester"), [
    "Outer: 91% Polyester",
    "9% Elastane",
    "Inner: 100% Polyester",
  ]);
});

test("decimals in either notation are one fibre, not two", () => {
  assert.deepEqual(lines("1,5% Elastane 98,5% Bomuld"), ["1,5% Elastane", "98,5% Bomuld"]);
  assert.deepEqual(lines("1.5% Elastane 98.5% Cotton"), ["1.5% Elastane", "98.5% Cotton"]);
});

test("a line with fewer than two percentages is never broken", () => {
  assert.deepEqual(lines("100% Cotton"), ["100% Cotton"]);
  // No percentage at all, and a value whose second clause isn't a percentage.
  assert.deepEqual(lines("Upper: Textile, Sole: Textile"), ["Upper: Textile", "Sole: Textile"]);
  assert.deepEqual(lines("Top + Inner skirt : 100% Cotton,1 layer of tulle"), [
    "Top + Inner skirt : 100% Cotton,1 layer of tulle",
  ]);
});

test("idempotent — an already-split value re-splits to itself", () => {
  const once = formatCompositionFibreLines("82% Acrylic, 17% Polyester, 1% Elastane");
  assert.equal(formatCompositionFibreLines(once), once);
});

test("empty input is returned unchanged", () => {
  assert.equal(formatCompositionFibreLines(""), "");
});

test("{{compositionLines}} resolves the same value as {{composition}}, one fibre per line", () => {
  const style: StyleData = {
    ...buildSampleStyleData(),
    composition: [{ language: "en", text: "95% Cotton 5% Elastane" }],
  };
  assert.equal(resolveTextToken(style, "composition"), "95% Cotton 5% Elastane");
  assert.equal(resolveTextToken(style, "compositionLines"), "95% Cotton\n5% Elastane");
});

test("the new token still requests its language's translation", () => {
  // Without this, a layout using only {{compositionLines:da}} would never have
  // a Danish composition built and would print the English one.
  const def = LayoutDefSchema.parse({
    pages: [{ id: "p1", title: "", widthMm: 30, heightMm: 60,
      blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 12 },
        lines: ["{{compositionLines:da}}", "{{composition:de}}"] }] }],
  });
  assert.deepEqual(compositionLangsInDef(def).sort(), ["da", "de"]);
});
