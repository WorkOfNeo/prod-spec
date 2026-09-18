import { test } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "@/lib/pdf/types";
import type { LayoutDef } from "./schema";
import { resolveTextToken, langArgsInDef } from "./tokens";

// {{careInstructions:salling}} switches the SOURCE of the care wording from
// the catalogue + translation bank to the customer-supplied "TEXT ON LABEL:"
// block in Monday's Style Comments field. These lock the two things that make
// that safe: the source actually switches, and ":salling" never leaks into the
// language namespace it shares with {{careInstructions:da}}.

const LIVE_BLOCK =
  "TEXT ON LABEL: \nVaskes før brug.\nVaskes med vrangen ud.\nVaskes med lignende farver.\nKrymp max 5%";

function makeStyle(over: Partial<StyleData>): StyleData {
  return {
    styleName: "Base Style",
    styleNumber: "IL0001",
    customerName: "Salling Group A/S",
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

test("{{careInstructions:salling}} reads the Style Comments block", () => {
  const style = makeStyle({ styleCommentsRaw: LIVE_BLOCK });
  assert.equal(
    resolveTextToken(style, "careInstructions", "salling"),
    "Vaskes før brug.\nVaskes med vrangen ud.\nVaskes med lignende farver.\nKrymp max 5%",
  );
});

test("the language form is untouched by the new source", () => {
  const style = makeStyle({
    styleCommentsRaw: LIVE_BLOCK,
    careInstructionsByLang: { da: "vaskes ved 30°" },
  });
  // :da still resolves from the translation-backed map, capitalized as ever.
  assert.equal(resolveTextToken(style, "careInstructions", "da"), "Vaskes ved 30°");
  // …and the catalogue text does NOT leak into the salling form.
  assert.equal(resolveTextToken(style, "careInstructions", "salling").includes("30°"), false);
});

test("the salling form ignores the per-language map entirely", () => {
  // A style with catalogue care text but no TEXT ON LABEL block prints
  // nothing, rather than silently falling back to the catalogue wording.
  const style = makeStyle({ careInstructionsByLang: { en: "Machine wash 30" } });
  assert.equal(resolveTextToken(style, "careInstructions", "salling"), "");
});

test("an unprefixed comment never reaches the label", () => {
  const style = makeStyle({ styleCommentsRaw: "Customer requires mock-up for print before production" });
  assert.equal(resolveTextToken(style, "careInstructions", "salling"), "");
});

// The guard that matters most: langArgsInDef feeds augmentTranslatedFields,
// so an unfiltered ":salling" would send the translation bank hunting for a
// "salling" language on every render.
test("langArgsInDef excludes :salling but keeps real languages", () => {
  const def = defWithLines(["{{careInstructions:salling}}", "{{careInstructions:da}}", "{{careInstructions:en}}"]);
  assert.deepEqual(langArgsInDef(def, "careInstructions").sort(), ["da", "en"]);
});

test("langArgsInDef returns nothing when only the salling source is used", () => {
  assert.deepEqual(langArgsInDef(defWithLines(["{{careInstructions:salling}}"]), "careInstructions"), []);
});
