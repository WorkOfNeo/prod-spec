import { test } from "node:test";
import assert from "node:assert/strict";
import { hasPerRowCartonEan, layoutSettings, type LayoutSettings } from "./schema";

// ---------------------------------------------------------------------------
// hasPerRowCartonEan is the SINGLE definition of "this layout binds a carton
// per repetition row". Three places must agree on it or the app contradicts
// itself on the same style:
//   • TemplateVariant.perRowCartonEan  → the readiness / Run gate
//   • the Output Builder test-style picker → "missing Carton EAN" labelling
//   • repetitionStyles                 → what actually renders
// A style with per-size cartons and a NULL Style.cartonEan is renderable on a
// per-row layout and blank on a style-level one, so the split has to be exact.
// ---------------------------------------------------------------------------

function settings(repeatBy: LayoutSettings["repeatBy"]): LayoutSettings {
  return {
    repeatBy,
    splitBy: "ean",
    fileName: "",
    cartonNumbering: false,
    multipleStyles: false,
    customLogoWidthPct: 100,
  rules: [],
  };
}

test("per-row repeats: the row's own carton is bound", () => {
  assert.equal(hasPerRowCartonEan(settings("ean")), true);
  assert.equal(hasPerRowCartonEan(settings("cartonEan")), true);
});

test("style-level repeats: one carton for the whole style", () => {
  // "none" and "size" print Style.cartonEan; "assort" prints the master
  // carton — none of them narrow to a per-size carton.
  assert.equal(hasPerRowCartonEan(settings("none")), false);
  assert.equal(hasPerRowCartonEan(settings("size")), false);
  assert.equal(hasPerRowCartonEan(settings("assort")), false);
});

test("a definition with no settings block defaults to style-level", () => {
  const def = { pages: [] } as unknown as Parameters<typeof layoutSettings>[0];
  assert.equal(hasPerRowCartonEan(layoutSettings(def)), false);
});
