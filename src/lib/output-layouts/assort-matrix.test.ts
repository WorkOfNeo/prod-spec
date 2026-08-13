import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load (nothing here queries).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let resolveTextToken: typeof import("./tokens").resolveTextToken;
let evaluateCalcForStyle: typeof import("./tokens").evaluateCalcForStyle;
let projectSiblingStyle: typeof import("./tokens").projectSiblingStyle;
let validateTokenRef: typeof import("./token-meta").validateTokenRef;
let qtyForSizeLabel: typeof import("./size-ratio").qtyForSizeLabel;
let totalSizeRatioQty: typeof import("./size-ratio").totalSizeRatioQty;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ resolveTextToken, evaluateCalcForStyle, projectSiblingStyle } = await import("./tokens"));
  ({ validateTokenRef } = await import("./token-meta"));
  ({ qtyForSizeLabel, totalSizeRatioQty } = await import("./size-ratio"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

type Sz = { label: string; ean13: string };
const sizes = (...labels: string[]): Sz[] => labels.map((label) => ({ label, ean13: "" }));

// A style carrying a size run + the buyer's Size Ratio text, over the shared
// sample so every unrelated field is a realistic value rather than undefined
// (projectSiblingStyle resolves the whole projection, not just the sizes).
function styleWith(opts: {
  sizeLabels: string[];
  ratio?: string;
  colourName?: string;
  // Narrowed repetition row, to prove the matrix stays style-scoped.
  rowSizes?: string[];
  siblings?: Array<{ sizeLabels: string[]; ratio?: string; colourName?: string }>;
  multipleStyles?: boolean;
}) {
  const one = (o: { sizeLabels: string[]; ratio?: string; colourName?: string; rowSizes?: string[] }) =>
    ({
      ...buildSampleStyleData(),
      sizes: sizes(...(o.rowSizes ?? o.sizeLabels)),
      allSizes: sizes(...o.sizeLabels),
      sizeRatioRaw: o.ratio,
      colour: o.colourName ? { name: o.colourName, code: "" } : undefined,
    }) as import("../pdf/types").StyleData;

  const siblings = (opts.siblings ?? []).map((s, i) => projectSiblingStyle(one(s), `sib-${i + 1}`));
  return {
    ...one(opts),
    multipleStyles: opts.multipleStyles ?? (opts.siblings?.length ?? 0) > 0,
    siblings,
  } as import("../pdf/types").StyleData;
}

const at = (s: import("../pdf/types").StyleData, key: string, n?: number) =>
  resolveTextToken(s, key, n === undefined ? undefined : String(n));

// ---------------------------------------------------------------------
// Columns — {{sizeAt:N}} is the header the whole matrix lines up under.
// ---------------------------------------------------------------------

test("sizeAt reads the run left to right, 1-based", () => {
  const s = styleWith({ sizeLabels: ["S", "M", "L", "XL"], ratio: "1,1,1,1" });
  assert.equal(at(s, "sizeAt", 1), "S");
  assert.equal(at(s, "sizeAt", 4), "XL");
});

test("a column past the end of the run is blank, not an error", () => {
  // The form has seven size columns; this style is made in four. The three
  // spare boxes must print empty — that is the whole point of authoring one
  // layout for many styles.
  const s = styleWith({ sizeLabels: ["S", "M", "L", "XL"], ratio: "1,1,1,1" });
  assert.equal(at(s, "sizeAt", 5), "");
  assert.equal(at(s, "sizeQty", 7), "");
});

test("a missing or junk index resolves empty rather than throwing", () => {
  const s = styleWith({ sizeLabels: ["S", "M"], ratio: "1,2" });
  for (const bad of [undefined, "0", "-1", "2.5", "abc", ""]) {
    assert.equal(resolveTextToken(s, "sizeQty", bad), "", `arg ${JSON.stringify(bad)}`);
  }
});

test("the matrix is STYLE-scoped: a per-size repeat still shows every column", () => {
  // The repetition row narrowed to M, but a matrix printed on that row must
  // still carry the full run — otherwise a 4-size assortment comes out as
  // four one-column tables. Same rule as {{sizeRange}}.
  const s = styleWith({
    sizeLabels: ["S", "M", "L", "XL"],
    rowSizes: ["M"],
    ratio: "S-1, M-2, L-2, XL-1",
  });
  assert.equal(at(s, "sizeAt", 1), "S");
  assert.equal(at(s, "sizeAt", 4), "XL");
  assert.equal(at(s, "sizeQty", 2), "2");
  assert.equal(at(s, "sizeQtyTotal"), "6");
});

// ---------------------------------------------------------------------
// Cells + row totals.
// ---------------------------------------------------------------------

test("positional and labelled ratios both fill the row", () => {
  const positional = styleWith({ sizeLabels: ["S", "M", "L"], ratio: "2,7,1" });
  assert.deepEqual([1, 2, 3].map((n) => at(positional, "sizeQty", n)), ["2", "7", "1"]);

  const labelled = styleWith({ sizeLabels: ["S", "M", "L"], ratio: "S-2, M-7, L-1" });
  assert.deepEqual([1, 2, 3].map((n) => at(labelled, "sizeQty", n)), ["2", "7", "1"]);
});

test("the row total adds the cells, and is blank when nothing is readable", () => {
  assert.equal(at(styleWith({ sizeLabels: ["S", "M", "L"], ratio: "2,7,1" }), "sizeQtyTotal"), "10");
  // No ratio column at all ⇒ "" (an empty cell), never a confident "0" on a
  // shipping document.
  assert.equal(at(styleWith({ sizeLabels: ["S", "M"] }), "sizeQtyTotal"), "");
  assert.equal(at(styleWith({ sizeLabels: ["S", "M"], ratio: "nonsense" }), "sizeQtyTotal"), "");
});

test("qtyForSizeLabel matches space- and case-insensitively", () => {
  const entries = [
    { size: "4-5 ÅR", qty: "3" },
    { size: "S", qty: "1" },
  ];
  assert.equal(qtyForSizeLabel(entries, "4-5år"), "3");
  assert.equal(qtyForSizeLabel(entries, "  s "), "1");
  assert.equal(qtyForSizeLabel(entries, "XL"), "");
  assert.equal(totalSizeRatioQty(entries), "4");
});

// ---------------------------------------------------------------------
// The colour axis — one row per style, which is what makes it a matrix.
// ---------------------------------------------------------------------

test("each sibling slot is a row, addressed by the SAME column numbers", () => {
  const s = styleWith({
    sizeLabels: ["S", "M", "L", "XL"],
    ratio: "1,1,1,1",
    colourName: "Black",
    siblings: [
      { sizeLabels: ["S", "M", "L", "XL"], ratio: "1,2,2,1", colourName: "Off White" },
    ],
  });
  assert.equal(at(s, "colourName"), "Black");
  assert.deepEqual([1, 2, 3, 4].map((n) => at(s, "sizeQty", n)), ["1", "1", "1", "1"]);

  assert.equal(at(s, "style2ColourName"), "Off White");
  assert.deepEqual([1, 2, 3, 4].map((n) => at(s, "style2SizeQty", n)), ["1", "2", "2", "1"]);
  assert.equal(at(s, "style2SizeQtyTotal"), "6");
});

test("a slot with no sibling leaves its whole row blank", () => {
  // "Assume the blank lines should be filled if multiple styles" — the
  // converse is what makes one layout serve a 1-colour and a 5-colour pack.
  const s = styleWith({ sizeLabels: ["S", "M"], ratio: "1,1", colourName: "Black" });
  assert.equal(at(s, "style3ColourName"), "");
  assert.equal(at(s, "style3SizeQty", 1), "");
  assert.equal(at(s, "style3SizeQtyTotal"), "");
});

test("a sibling made in fewer sizes leaves THAT cell blank, not shifted", () => {
  // The failure this prevents: matching by position would print the
  // sibling's L quantity in the XL column and mis-declare the carton.
  const s = styleWith({
    sizeLabels: ["S", "M", "L", "XL"],
    ratio: "1,1,1,1",
    siblings: [{ sizeLabels: ["S", "M", "L"], ratio: "5,6,7", colourName: "Navy" }],
  });
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => at(s, "style2SizeQty", n)),
    ["5", "6", "7", ""],
  );
});

test("siblings resolve only in multi-style mode", () => {
  const s = styleWith({
    sizeLabels: ["S", "M"],
    ratio: "1,1",
    siblings: [{ sizeLabels: ["S", "M"], ratio: "2,2", colourName: "Navy" }],
    multipleStyles: false,
  });
  assert.equal(at(s, "style2SizeQty", 1), "");
});

test("the grand total sums the rows via the existing aggregate", () => {
  const s = styleWith({
    sizeLabels: ["S", "M", "L", "XL"],
    ratio: "1,1,1,1",
    siblings: [
      { sizeLabels: ["S", "M", "L", "XL"], ratio: "1,2,2,1" },
      { sizeLabels: ["S", "M", "L", "XL"], ratio: "1,1,1,1" },
    ],
  });
  assert.equal(evaluateCalcForStyle("sum(sizeQtyTotal)", s), "14");
});

// ---------------------------------------------------------------------
// Authoring gate — a bad index must be caught at publish, not at print.
// ---------------------------------------------------------------------

test("the publish gate requires a whole column number, on base AND sibling", () => {
  for (const key of ["sizeAt", "sizeQty", "style2SizeQty"]) {
    assert.deepEqual(validateTokenRef(key, "1"), [], key);
    assert.deepEqual(validateTokenRef(key, "24"), [], key);
    assert.equal(validateTokenRef(key, undefined).length, 1, `${key} bare`);
    assert.equal(validateTokenRef(key, "0").length, 1, `${key} :0`);
    assert.equal(validateTokenRef(key, "25").length, 1, `${key} :25`);
  }
});

test("the row totals take no argument", () => {
  assert.deepEqual(validateTokenRef("sizeQtyTotal", undefined), []);
  assert.deepEqual(validateTokenRef("style2SizeQtyTotal", undefined), []);
  assert.equal(validateTokenRef("sizeQtyTotal", "2").length, 1);
});

test("an argument on a non-assortment sibling field still resolves empty", () => {
  const s = styleWith({
    sizeLabels: ["S"],
    ratio: "1",
    siblings: [{ sizeLabels: ["S"], ratio: "1", colourName: "Navy" }],
  });
  assert.equal(at(s, "style2ColourName", 1), "");
  assert.equal(at(s, "style2ColourName"), "Navy");
});
