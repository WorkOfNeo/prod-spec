import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "../pdf/types";

// render.ts transitively imports @/lib/db, whose client construction needs
// DATABASE_URL at import time. Nothing here queries — set a dummy URL so the
// modules load. (Same shim as assort.test.ts.)
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let repetitionStyles: typeof import("./render").repetitionStyles;
let resolveTextToken: typeof import("./tokens").resolveTextToken;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ repetitionStyles } = await import("./render"));
  ({ resolveTextToken } = await import("./tokens"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

// A 2-pack style: two colourways (Pink + Blue) on the same sizes, each with its
// own PO EAN row — the multi-colourway case the PO colour exists to preserve.
function twoPack(useStyleBoardColour?: boolean): StyleData {
  const base = buildSampleStyleData();
  return {
    ...base,
    colour: { name: "Board Colour", code: "BRD-1" },
    useStyleBoardColour,
    eanVariants: [
      { size: "M", ean13: "5700123456780", colour: "Pink", cartonEan: null },
      { size: "M", ean13: "5700123456797", colour: "Blue", cartonEan: null },
    ],
  };
}

test("repeatBy 'ean' default (PO colour) → each row keeps its PO variant colour", () => {
  const reps = repetitionStyles(twoPack(), "ean");
  assert.equal(reps.length, 2);
  assert.equal(resolveTextToken(reps[0], "colourName"), "Pink");
  assert.equal(resolveTextToken(reps[1], "colourName"), "Blue");
  // The colour CODE always comes from the board, never the PO label.
  assert.equal(resolveTextToken(reps[0], "colourCode"), "BRD-1");
  assert.equal(resolveTextToken(reps[1], "colourCode"), "BRD-1");
});

test("repeatBy 'ean' with useStyleBoardColour → every row prints the board colour name", () => {
  const reps = repetitionStyles(twoPack(true), "ean");
  assert.equal(reps.length, 2);
  // Both per-EAN rows now bind the board colour instead of the PO label colour…
  assert.equal(resolveTextToken(reps[0], "colourName"), "Board Colour");
  assert.equal(resolveTextToken(reps[1], "colourName"), "Board Colour");
  // …and the code is still the board's.
  assert.equal(resolveTextToken(reps[0], "colourCode"), "BRD-1");
  assert.equal(resolveTextToken(reps[1], "colourCode"), "BRD-1");
});

test("useStyleBoardColour === false is identical to the default (undefined)", () => {
  const asFalse = repetitionStyles(twoPack(false), "ean");
  assert.equal(resolveTextToken(asFalse[0], "colourName"), "Pink");
  assert.equal(resolveTextToken(asFalse[1], "colourName"), "Blue");
});

test("useStyleBoardColour does NOT affect repeatBy 'size' rows", () => {
  // Per-size rows never carried the PO colour override, so the flag is a no-op
  // there — they always reflect the board colour regardless.
  const reps = repetitionStyles(twoPack(true), "size");
  assert.ok(reps.length > 0);
  for (const r of reps) assert.equal(resolveTextToken(r, "colourName"), "Board Colour");
});
