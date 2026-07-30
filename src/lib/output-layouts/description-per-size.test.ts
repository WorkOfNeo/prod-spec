import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "../pdf/types";

// render.ts / tokens.ts transitively import @/lib/db; nothing here queries.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let repetitionStyles: typeof import("./render").repetitionStyles;
let resolveTextToken: typeof import("./tokens").resolveTextToken;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ repetitionStyles } = await import("./render"));
  ({ resolveTextToken } = await import("./tokens"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

// The reported style: one description per size, comma-separated, sizes as
// words inside each entry (no "SIZE:" anchors), printed on a repeat-per-EAN
// layout where every PDF showed all five.
const DESCRIPTION =
  "Kalsonger Svart S 5-pack, Kalsonger Svart M 5-pack, Kalsonger Svart L 5-pack, " +
  "Kalsonger Svart XL\n5-pack, Kalsonger Svart XXL\n5-pack";
const SIZES = ["S", "M", "L", "XL", "XXL"];

// A style whose size run + EAN rows mirror the real one.
function styleWithPerSizeDescription(): StyleData {
  const base = buildSampleStyleData();
  const sizes = SIZES.map((label, i) => ({
    label,
    ean13: `570632360246${i}`,
  })) as StyleData["sizes"];
  return {
    ...base,
    description: DESCRIPTION,
    sizes,
    allSizes: undefined,
    eanVariants: SIZES.map((size, i) => ({
      size,
      ean13: `570632360246${i}`,
      colour: "Svart",
      cartonEan: null,
    })),
  } as StyleData;
}

test("repeat-per-EAN: each row's {{description:size}} prints only its size", () => {
  const rows = repetitionStyles(styleWithPerSizeDescription(), "ean");
  assert.equal(rows.length, 5);
  const printed = rows.map((r) => resolveTextToken(r, "description", "size"));
  assert.deepEqual(printed, [
    "Kalsonger Svart S 5-pack",
    "Kalsonger Svart M 5-pack",
    "Kalsonger Svart L 5-pack",
    "Kalsonger Svart XL 5-pack",
    "Kalsonger Svart XXL 5-pack",
  ]);
});

test("bare {{description}} is UNCHANGED on the same rows — old layouts safe", () => {
  const rows = repetitionStyles(styleWithPerSizeDescription(), "ean");
  for (const row of rows) {
    assert.equal(resolveTextToken(row, "description"), DESCRIPTION);
  }
});

test("repeat-per-size narrows the same way", () => {
  const rows = repetitionStyles(styleWithPerSizeDescription(), "size");
  assert.equal(resolveTextToken(rows[3], "description", "size"), "Kalsonger Svart XL 5-pack");
});

test("no repetition → :size prints the whole list (same as bare)", () => {
  const s = styleWithPerSizeDescription();
  assert.equal(resolveTextToken(s, "description", "size"), resolveTextToken(s, "description"));
});

test("a plain description is untouched by :size", () => {
  const s = { ...buildSampleStyleData(), description: "T-Shirt Paw Patrol – Blue" } as StyleData;
  const rows = repetitionStyles(s, "ean");
  for (const row of rows) {
    assert.equal(resolveTextToken(row, "description", "size"), "T-Shirt Paw Patrol – Blue");
  }
});

test("an ANCHORED per-size list still works through :size (strategies compose)", () => {
  const base = buildSampleStyleData();
  const sizes = [
    { label: "4-5 ÅR", ean13: "7070001349999" },
    { label: "6-7 ÅR", ean13: "7070001350001" },
  ] as StyleData["sizes"];
  const s = {
    ...base,
    // The "SIZE: value" shape repetitionStyles already narrows before tokens run.
    description: "4-5 ÅR: HIPSTER 2PK ROSA 4-5 ÅR, 6-7 ÅR: HIPSTER 2PK ROSA 6-7 ÅR",
    sizes,
    allSizes: undefined,
    eanVariants: [
      { size: "4-5 ÅR", ean13: "7070001349999", colour: "Rosa", cartonEan: null },
      { size: "6-7 ÅR", ean13: "7070001350001", colour: "Rosa", cartonEan: null },
    ],
  } as StyleData;
  const rows = repetitionStyles(s, "ean");
  // The anchor pass already reduced each row to one entry; :size is a no-op.
  assert.equal(resolveTextToken(rows[0], "description", "size"), "HIPSTER 2PK ROSA 4-5 ÅR");
  assert.equal(resolveTextToken(rows[0], "description"), "HIPSTER 2PK ROSA 4-5 ÅR");
});
