import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "@/lib/pdf/types";

// See omit-empty-page.test.ts — the render module transitively constructs the
// db client at import time, so a dummy DATABASE_URL lets it load. Nothing
// here queries: repetitionStyles and the token resolvers are pure.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let resolveTextToken: typeof import("./tokens").resolveTextToken;
let repetitionStyles: typeof import("./render").repetitionStyles;

before(async () => {
  ({ resolveTextToken } = await import("./tokens"));
  ({ repetitionStyles } = await import("./render"));
});

// ---------------------------------------------------------------------
// {{sizeRange}} LISTS every size in the style's full run — "S, M, L", not
// the "S–L" endpoints — and does so even inside a per-size / per-EAN
// repetition: the run is a property of the STYLE ("sizes available for this
// product"), so every split file must read the same. {{size}} (the row's
// size) and {{sizes}} (the row's list) stay narrowed; these lock that split,
// plus the one row type that legitimately covers a GROUP of sizes: a
// per-carton row, which lists its own sizes.
// ---------------------------------------------------------------------

const RUN = ["86/92", "98/104", "110/116", "122/128"];

function makeStyle(over: Partial<StyleData> = {}): StyleData {
  return {
    styleName: "Base Style",
    styleNumber: "IL0001",
    customerName: "Ge-kås Ullared AB",
    businessArea: "LICENSE",
    composition: [],
    productNameTranslations: [],
    washSymbols: [],
    sizes: RUN.map((label, i) => ({ label, ean13: `570012345670${i}` })),
    carton: { klNumber: "", supplierNumber: "", lot: "", outerVE: 0, ean13: "" },
    ...over,
  };
}

const range = (s: StyleData) => resolveTextToken(s, "sizeRange");
const sizes = (s: StyleData) => resolveTextToken(s, "sizes");
const size = (s: StyleData) => resolveTextToken(s, "size");

test("no repetition — every size in the run is listed", () => {
  assert.equal(range(makeStyle()), "86/92, 98/104, 110/116, 122/128");
});

test("repeat per size: every file lists the whole run, not its own size", () => {
  const reps = repetitionStyles(makeStyle(), "size");
  assert.equal(reps.length, 4);
  for (const rep of reps) assert.equal(range(rep), "86/92, 98/104, 110/116, 122/128");
  // …while {{size}} / {{sizes}} stay bound to the row.
  assert.deepEqual(reps.map(size), RUN);
  assert.deepEqual(reps.map(sizes), RUN);
});

test("repeat per EAN (size × colour) — same, across both colourways", () => {
  const style = makeStyle({
    eanVariants: [
      { size: "86/92", ean13: "5700123456701", colour: "Navy" },
      { size: "110/116", ean13: "5700123456702", colour: "Navy" },
      { size: "86/92", ean13: "5700123456703", colour: "Pink" },
    ],
  });
  const reps = repetitionStyles(style, "ean");
  assert.equal(reps.length, 3);
  for (const rep of reps) assert.equal(range(rep), "86/92, 98/104, 110/116, 122/128");
  assert.deepEqual(reps.map(size), ["86/92", "110/116", "86/92"]);
});

test("a per-carton row lists ITS sizes, not the whole run", () => {
  // Two sizes share carton A, one sits alone on carton B.
  const style = makeStyle({
    carton: {
      klNumber: "",
      supplierNumber: "",
      lot: "",
      outerVE: 0,
      ean13: "",
      perSize: [
        { size: "86/92", cartonEan: "5700000000010", productEan13: "5700123456701", colour: null },
        { size: "98/104", cartonEan: "5700000000010", productEan13: "5700123456702", colour: null },
        { size: "122/128", cartonEan: "5700000000027", productEan13: "5700123456704", colour: null },
      ],
    },
  });
  const reps = repetitionStyles(style, "cartonEan");
  assert.equal(reps.length, 2);
  assert.equal(range(reps[0]), "86/92, 98/104"); // the sizes in THAT carton
  assert.equal(sizes(reps[0]), "86/92, 98/104");
  assert.equal(range(reps[1]), "122/128"); // single-size carton — no separator
});

test("a single-size style prints the bare label, never a separator", () => {
  const style = makeStyle({ sizes: [{ label: "ONE SIZE", ean13: "5700123456701" }] });
  assert.equal(range(style), "ONE SIZE");
  for (const rep of repetitionStyles(style, "size")) assert.equal(range(rep), "ONE SIZE");
});

test("no sizes at all resolves empty (the line drops in production)", () => {
  assert.equal(range(makeStyle({ sizes: [] })), "");
});
