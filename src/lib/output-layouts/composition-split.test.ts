import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "../pdf/types";
import { parseCompositionParts, splitCompositionByColour } from "./composition";

// render.ts transitively imports @/lib/db, whose client construction needs
// DATABASE_URL at import time. Nothing here queries — set a dummy URL so the
// modules load. (Same shim as colour-source.test.ts.)
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let repetitionStyles: typeof import("./render").repetitionStyles;
let resolveTextToken: typeof import("./tokens").resolveTextToken;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ repetitionStyles } = await import("./render"));
  ({ resolveTextToken } = await import("./tokens"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

// ---------------------------------------------------------------------------
// The discriminator. Every string below is a REAL live value — the colour-keyed
// ones from the Coop DK and Kaufland two-quality packs this feature was built
// for, the rest from the 94 garment-part styles that must not split.
// ---------------------------------------------------------------------------

const COOP = "Pink: 95% Cotton 5% Elastane, Grey melange: 57% Cotton 38% Polyester 5% Elastane";
const KAUFLAND = "LGM: 57% Cotton 38% Polyester 5% Elastane / Green: 95% Cotton 5% Elastan";

test("colour-keyed composition splits — comma separated (Coop)", () => {
  const parts = splitCompositionByColour(COOP, ["Grey melange", "Pink"]);
  assert.deepEqual(parts, [
    { label: "Pink", text: "95% Cotton 5% Elastane" },
    { label: "Grey melange", text: "57% Cotton 38% Polyester 5% Elastane" },
  ]);
});

test("colour-keyed composition splits — slash separated (Kaufland)", () => {
  const parts = splitCompositionByColour(KAUFLAND, ["LGM", "Green"]);
  assert.deepEqual(parts, [
    { label: "LGM", text: "57% Cotton 38% Polyester 5% Elastane" },
    { label: "Green", text: "95% Cotton 5% Elastan" },
  ]);
});

test("colour match ignores case and punctuation, never guesses", () => {
  // "(Grey melange)" off a style name matches "Grey melange:" …
  assert.ok(splitCompositionByColour(COOP, ["GREY MELANGE", "pink"]));
  // … but an abbreviation is NOT fuzzy-matched to the spelt-out colour.
  assert.equal(splitCompositionByColour(COOP, ["LGM", "Pink"]), null);
});

test("garment-part compositions never split, whatever the separator", () => {
  const partShapes = [
    "Top: 100% Cotton, Bottom: 60% Cotton 40% Polyester",
    "Upper: Textile, Sole: Textile",
    "Outer: 91% Polyester 9% Elastane Inner: 100% Polyester",
    "Lining: 100% Cotton, Skirt: 1 layer 100% Polyester tulle",
    "Part 1: 100% Polyester, Part 2: 30% Polyester 70% Recycled Cotton",
  ];
  for (const text of partShapes) {
    assert.equal(splitCompositionByColour(text, ["Navy", "White", "Pink"]), null, text);
  }
});

test("a single composition, and a style with no declared colours, never split", () => {
  assert.equal(splitCompositionByColour("95% Cotton 5% Elastane", ["Pink"]), null);
  assert.equal(splitCompositionByColour(COOP, []), null);
});

test("one unmatched label disqualifies the whole string", () => {
  // Half a match is far likelier to be a garment-part composition sharing a
  // word with a colour than a genuine per-colour pack.
  assert.equal(splitCompositionByColour(COOP, ["Pink"]), null);
});

test("parseCompositionParts keeps multi-word labels whole", () => {
  // The bug this replaced: an anchor of "one word before a colon" read
  // "…Elastane, Grey" + "melange:" and broke the colour name in half.
  assert.deepEqual(
    parseCompositionParts(COOP).map((p) => p.label),
    ["Pink", "Grey melange"],
  );
});

// ---------------------------------------------------------------------------
// The repetition axis.
// ---------------------------------------------------------------------------

// The live shape: a 2-pack naming its colours in the style NAME (the PO EAN
// rows are MIX rows and carry no colour at all), one EAN per size.
function twoQualityPack(): StyleData {
  return {
    ...buildSampleStyleData(),
    styleName: "ST40011 (Grey melange)+ ST40012 (Pink)",
    colour: undefined,
    composition: [{ language: "en", text: COOP }],
    eanVariants: [
      { size: "86/92", ean13: "5700123456780", colour: null, cartonEan: null },
      { size: "98/104", ean13: "5700123456797", colour: null, cartonEan: null },
    ],
  };
}

test("off by default — the flag is what splits, never the data alone", () => {
  const reps = repetitionStyles(twoQualityPack(), "ean");
  // Two SIZE rows, and both compositions on each label: one document per size,
  // the two qualities printed as two lines (the pre-existing behaviour).
  assert.equal(reps.length, 2);
  assert.equal(
    resolveTextToken(reps[0], "composition"),
    "Pink: 95% Cotton 5% Elastane\nGrey melange: 57% Cotton 38% Polyester 5% Elastane",
  );
});

test("un-split, a multi-word colour label survives the line break whole", () => {
  // Regression: the break anchor used to be "a single word before a colon",
  // which read "…Elastane, Grey" + "melange:" and printed the colour in half.
  const [row] = repetitionStyles(twoQualityPack(), "ean");
  assert.ok(!resolveTextToken(row, "composition").includes("Grey\nmelange"));
  // The Kaufland slash separator is consumed by the break, not stranded.
  const kaufland = { ...twoQualityPack(), composition: [{ language: "en", text: KAUFLAND }] };
  assert.equal(
    resolveTextToken(repetitionStyles(kaufland, "none")[0], "composition"),
    "LGM: 57% Cotton 38% Polyester 5% Elastane\nGreen: 95% Cotton 5% Elastan",
  );
});

test("splitByComposition multiplies the repeat: 2 sizes × 2 colours = 4 rows", () => {
  const reps = repetitionStyles(twoQualityPack(), "ean", { splitByComposition: true });
  assert.equal(reps.length, 4);
  assert.deepEqual(
    reps.map((r) => [r.sizes[0].label, r.compositionColour, resolveTextToken(r, "composition")]),
    [
      ["86/92", "Pink", "95% Cotton 5% Elastane"],
      ["86/92", "Grey melange", "57% Cotton 38% Polyester 5% Elastane"],
      ["98/104", "Pink", "95% Cotton 5% Elastane"],
      ["98/104", "Grey melange", "57% Cotton 38% Polyester 5% Elastane"],
    ],
  );
});

test("each row prints ONLY its own fibres — the colour label is dropped", () => {
  const [first] = repetitionStyles(twoQualityPack(), "ean", { splitByComposition: true });
  assert.equal(resolveTextToken(first, "composition"), "95% Cotton 5% Elastane");
  assert.equal(resolveTextToken(first, "compositionColour"), "Pink");
});

test("splits a non-repeating layout too — repeatBy 'none' still yields 2 rows", () => {
  const reps = repetitionStyles(twoQualityPack(), "none", { splitByComposition: true });
  assert.deepEqual(reps.map((r) => r.compositionColour), ["Pink", "Grey melange"]);
});

test("idempotent — renderLayoutHtml re-runs this on rows renderMany narrowed", () => {
  const reps = repetitionStyles(twoQualityPack(), "ean", { splitByComposition: true });
  for (const row of reps) {
    const again = repetitionStyles(row, "ean", { splitByComposition: true });
    assert.equal(again.length, 1);
    assert.equal(resolveTextToken(again[0], "composition"), resolveTextToken(row, "composition"));
  }
});

test("every language is narrowed to the SAME part by index", () => {
  const style: StyleData = {
    ...twoQualityPack(),
    composition: [
      { language: "en", text: COOP },
      { language: "da", text: "Pink: 95% Bomuld 5% Elastan, Grey melange: 57% Bomuld 38% Polyester 5% Elastan" },
    ],
  };
  const reps = repetitionStyles(style, "none", { splitByComposition: true });
  assert.equal(resolveTextToken(reps[0], "composition", "da"), "95% Bomuld 5% Elastan");
  assert.equal(resolveTextToken(reps[1], "composition", "da"), "57% Bomuld 38% Polyester 5% Elastan");
});

test("a language whose text doesn't parse into the same parts keeps its full value", () => {
  // Degrade to the whole string rather than print the wrong colour's fibres.
  const style: StyleData = {
    ...twoQualityPack(),
    composition: [
      { language: "en", text: COOP },
      { language: "da", text: "95% Bomuld 5% Elastan" },
    ],
  };
  const reps = repetitionStyles(style, "none", { splitByComposition: true });
  for (const rep of reps) assert.equal(resolveTextToken(rep, "composition", "da"), "95% Bomuld 5% Elastan");
});

test("a single-composition style is untouched by the flag", () => {
  const style: StyleData = {
    ...twoQualityPack(),
    composition: [{ language: "en", text: "95% Cotton 5% Elastane" }],
  };
  const reps = repetitionStyles(style, "ean", { splitByComposition: true });
  assert.equal(reps.length, 2); // the two sizes, and nothing more
  assert.equal(reps[0].compositionColour, undefined);
});
