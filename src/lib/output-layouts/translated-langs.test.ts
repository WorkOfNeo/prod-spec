import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "../pdf/types";
import type { LayoutDef } from "./schema";

// tokens.ts transitively imports @/lib/db, whose client construction needs
// DATABASE_URL at import time. Nothing here queries — the pg pool is lazy, and
// every case below runs on hand-built StyleData.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let translatedLangsInDefs: typeof import("./translated-langs").translatedLangsInDefs;
let needsTranslationAugment: typeof import("./translated-langs").needsTranslationAugment;
let documentLines: typeof import("./lines").documentLines;
let parseLayoutDef: typeof import("./schema").parseLayoutDef;

before(async () => {
  ({ translatedLangsInDefs, needsTranslationAugment } = await import("./translated-langs"));
  ({ documentLines } = await import("./lines"));
  ({ parseLayoutDef } = await import("./schema"));
});

// =====================================================
// Regression cover for the review surfaces disagreeing with the PDF.
//
// The renderer resolves {{composition:<lang>}} through the translation bank
// INSIDE renderLayoutHtml. Every sync consumer of the same StyleData — the
// review page's catch-all line editor (variant.lines → documentLines) and the
// field editor's pre-fills — resolves the token straight off StyleData. When
// the shared loader hands those surfaces an un-augmented style, the editor
// shows the line as empty while the sticker prints the translated text.
//
// Observed live on "SOK - License - Price Sticker" (layout
// <layout id>), style AAA10001 / C-PO12345: the sticker prints
//   "100% Polyesteri, 100% Polyester, 100% Polüester"
// and the line editor showed
//   ", ,"
// — which is exactly what a reviewer reports as "the ET composition is
// missing on this layout PDF".
// =====================================================

// The real SOK Price Sticker composition line, verbatim. Built lazily —
// parseLayoutDef only exists after the dynamic import above.
const sokDef = (): LayoutDef =>
  parseLayoutDef({
  pages: [
    {
      id: "p1",
      title: "Price sticker",
      widthMm: 25,
      heightMm: 16,
      gridCols: 24,
      gridRows: 16,
      margins: { topMm: 0.6, leftMm: 0.6, rightMm: 0.6, bottomMm: 0.6 },
      blocks: [
        {
          id: "b-r3",
          rect: { col: 0, row: 11, colSpan: 24, rowSpan: 5 },
          lines: ["{{composition:fi}}, {{composition:sv}}, {{composition:et}}"],
        },
        {
          id: "b-price",
          rect: { col: 13, row: 0, colSpan: 7, rowSpan: 3 },
          lines: ["{{price}} €"],
        },
      ],
    },
  ],
});

function styleWith(composition: StyleData["composition"]): StyleData {
  return {
    styleName: "AAA10001",
    styleNumber: "AAA10001",
    customerName: "Example Retailer",
    businessArea: "License",
    composition,
    productNameTranslations: [],
    washSymbols: [],
    sizes: [{ label: "98/104", ean13: "6438574709847" }],
    carton: { klNumber: "", supplierNumber: "", lot: "", outerVE: 0, ean13: "", assortEan: "" },
    colour: { name: "Pink", code: "*Pink" },
    price: { amount: 26.95 },
    barcodeFont: { family: "Helvetica", sizePt: 8 },
    prodSpecLogoSvg: null,
    careInstructionsByLang: {},
    outputLanguages: [],
    certificates: [],
    qrImageUrl: null,
  } as unknown as StyleData;
}

const compositionLine = (def: LayoutDef, style: StyleData) =>
  documentLines(def, style, undefined).find((l) => l.blockId === "b-r3")!.resolved;

test("collects every language the layouts print, deduped and lower-cased", () => {
  const langs = translatedLangsInDefs([sokDef()]);
  assert.deepEqual(langs.composition.sort(), ["et", "fi", "sv"]);
  assert.ok(needsTranslationAugment(langs));
});

test("a layout with no per-language tokens needs no dictionary round-trip", () => {
  const plain = parseLayoutDef({
    pages: [
      {
        id: "p1",
        widthMm: 25,
        heightMm: 16,
        gridCols: 24,
        gridRows: 16,
        blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 24, rowSpan: 4 }, lines: ["{{price}} €"] }],
      },
    ],
  });
  const langs = translatedLangsInDefs([plain]);
  assert.deepEqual(langs.composition, []);
  assert.equal(needsTranslationAugment(langs), false);
});

test("langs are collected across ALL declared layouts, not just the first", () => {
  const other = parseLayoutDef({
    pages: [
      {
        id: "p1",
        widthMm: 40,
        heightMm: 30,
        gridCols: 12,
        gridRows: 12,
        blocks: [
          {
            id: "b1",
            rect: { col: 0, row: 0, colSpan: 12, rowSpan: 4 },
            lines: ["{{composition:da}}", "{{madeIn:no}}", "{{careInstructions:fi}}"],
          },
        ],
      },
    ],
  });
  const langs = translatedLangsInDefs([sokDef(), other]);
  assert.deepEqual(langs.composition.sort(), ["da", "et", "fi", "sv"]);
  assert.deepEqual(langs.madeIn, ["no"]);
  assert.deepEqual(langs.care, ["fi"]);
});

// THE regression: an un-augmented style is what the review surfaces used to
// get, and it renders the composition line as bare separators. This is the
// shape the reviewer reported.
test("un-augmented style resolves the composition line to bare separators", () => {
  // parseTranslations' forgiveness path: a bare, un-prefixed Monday value
  // becomes a single EN entry — which is exactly what SOK's styles carry.
  const line = compositionLine(sokDef(), styleWith([{ language: "en", text: "100% Polyester" }]));
  assert.equal(line, ", ,");
  assert.ok(!line.includes("Polüester"), "no Estonian text without augmentation");
});

// After the loader augments (translatedLangsInDefs → augmentCompositionTranslations),
// the same sync resolve agrees with the PDF. The augmentation itself is
// dictionary-backed, so this pins the CONTRACT: given the translated entries
// on StyleData, the line editor prints what the sticker prints.
test("augmented style resolves the composition line exactly as the sticker prints it", () => {
  const line = compositionLine(
    sokDef(),
    styleWith([
      { language: "en", text: "100% Polyester" },
      { language: "fi", text: "100% Polyesteri" },
      { language: "sv", text: "100% Polyester" },
      { language: "et", text: "100% Polüester" },
    ]),
  );
  assert.equal(line, "100% Polyesteri, 100% Polyester, 100% Polüester");
});

// The price token is NOT translation-backed — it resolved identically on both
// paths all along. Pinned so a future change to the augmentation can't quietly
// make {{price}} depend on the dictionary.
test("{{price}} resolves without any augmentation", () => {
  const style = styleWith([{ language: "en", text: "100% Polyester" }]);
  const priceLine = documentLines(sokDef(), style, undefined).find((l) => l.blockId === "b-price")!;
  assert.equal(priceLine.resolved, "26.95 €");
});
