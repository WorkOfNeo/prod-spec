import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData, SiblingStyle } from "../pdf/types";

// tokens.ts transitively imports @/lib/db (care-labels, translations), whose
// client construction needs DATABASE_URL at import time. Nothing here ever
// queries — the pg pool is lazy — so a dummy URL lets the modules load. Set it
// before the dynamic imports below (node runs each test file in its own process).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let resolveTextToken: typeof import("./tokens").resolveTextToken;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ resolveTextToken } = await import("./tokens"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

// A carton-relevant sibling carrying just the description we want to assert on
// (the other fields are irrelevant to {{multipleStylesDescriptions}}).
function sibling(id: string, description: string): SiblingStyle {
  return {
    id,
    styleNumber: "",
    styleName: "",
    description,
    customerItemNo: "",
    colourName: "",
    colourCode: "",
    sizes: "",
    sizeRange: "",
    qtyPerCarton: "",
    cartonEan: "",
    ean13: "",
  };
}

// StyleData in multi-style mode with the given sibling descriptions — mirrors
// what withSelectedSiblings() leaves on the style after a carton pick.
function multiStyle(base: StyleData, siblingDescriptions: string[]): StyleData {
  return {
    ...base,
    multipleStyles: true,
    siblings: siblingDescriptions.map((d, i) => sibling(`sib${i}`, d)),
  };
}

test("single-style: falls back to the plain {{description}}", () => {
  const s = buildSampleStyleData();
  const expected = resolveTextToken(s, "description");
  assert.ok(expected.length > 0, "sample style has a description");
  assert.equal(resolveTextToken(s, "multipleStylesDescriptions"), expected);
});

test("single-style: a pre-fetched sibling pool is ignored while mode is off", () => {
  // The pool can ride on StyleData even in single-style mode; the token must
  // NOT leak it without style.multipleStyles.
  const s: StyleData = { ...buildSampleStyleData(), siblings: [sibling("x", "Leaked A")] };
  assert.equal(resolveTextToken(s, "multipleStylesDescriptions"), resolveTextToken(s, "description"));
});

test("multi-style: base first, then siblings in slot order, comma-joined", () => {
  const base = buildSampleStyleData();
  const s = multiStyle(base, ["Sibling Red", "Sibling Green"]);
  assert.equal(
    resolveTextToken(s, "multipleStylesDescriptions"),
    `${resolveTextToken(base, "description")}, Sibling Red, Sibling Green`,
  );
});

test("multi-style: blank descriptions are dropped (no dangling comma)", () => {
  const s = multiStyle(buildSampleStyleData(), ["", "  ", "Third"]);
  assert.equal(
    resolveTextToken(s, "multipleStylesDescriptions"),
    `${resolveTextToken(buildSampleStyleData(), "description")}, Third`,
  );
});

test("multi-style with an empty pick still resolves to the base description", () => {
  const base = buildSampleStyleData();
  assert.equal(
    resolveTextToken(multiStyle(base, []), "multipleStylesDescriptions"),
    resolveTextToken(base, "description"),
  );
});
