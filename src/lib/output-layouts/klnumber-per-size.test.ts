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

// Same shape as the reported {{description:size}} case (#274), but on the KL
// number: one entry per size, comma-separated, sizes as words inside each
// entry (no "SIZE:" anchors) — repetitionStyles has no anchor to narrow on,
// so every per-EAN PDF would show all entries without the :size argument.
const KL_NUMBER =
  "KL 1042 S, KL 1042 M, KL 1042 L, KL 1042\nXL, KL 1042\nXXL";
const SIZES = ["S", "M", "L", "XL", "XXL"];

function styleWithPerSizeKlNumber(): StyleData {
  const base = buildSampleStyleData();
  const sizes = SIZES.map((label, i) => ({
    label,
    ean13: `570632360246${i}`,
  })) as StyleData["sizes"];
  return {
    ...base,
    carton: { ...base.carton, klNumber: KL_NUMBER },
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

test("repeat-per-EAN: each row's {{klNumber:size}} prints only its size", () => {
  const rows = repetitionStyles(styleWithPerSizeKlNumber(), "ean");
  assert.equal(rows.length, 5);
  const printed = rows.map((r) => resolveTextToken(r, "klNumber", "size"));
  assert.deepEqual(printed, ["KL 1042 S", "KL 1042 M", "KL 1042 L", "KL 1042 XL", "KL 1042 XXL"]);
});

test("bare {{klNumber}} is UNCHANGED on the same rows — old layouts safe", () => {
  const rows = repetitionStyles(styleWithPerSizeKlNumber(), "ean");
  for (const row of rows) {
    assert.equal(resolveTextToken(row, "klNumber"), KL_NUMBER);
  }
});

test("repeat-per-size narrows the same way", () => {
  const rows = repetitionStyles(styleWithPerSizeKlNumber(), "size");
  assert.equal(resolveTextToken(rows[3], "klNumber", "size"), "KL 1042 XL");
});

test("no repetition → :size prints the whole list (same as bare)", () => {
  const s = styleWithPerSizeKlNumber();
  assert.equal(resolveTextToken(s, "klNumber", "size"), resolveTextToken(s, "klNumber"));
});

test("a plain KL number is untouched by :size", () => {
  const base = buildSampleStyleData();
  const s = { ...base, carton: { ...base.carton, klNumber: "KL 1042" } } as StyleData;
  const rows = repetitionStyles(s, "ean");
  for (const row of rows) {
    assert.equal(resolveTextToken(row, "klNumber", "size"), "KL 1042");
  }
});
