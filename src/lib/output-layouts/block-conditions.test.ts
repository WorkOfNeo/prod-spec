import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load (nothing here queries).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let schema: typeof import("./schema");
let tokenMetaMod: typeof import("./token-meta");
let tokens: typeof import("./tokens");
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let validateLayoutForPublish: typeof import("./publish-validation").validateLayoutForPublish;
let documentLines: typeof import("./lines").documentLines;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  schema = await import("./schema");
  tokenMetaMod = await import("./token-meta");
  tokens = await import("./tokens");
  ({ renderLayoutHtml } = await import("./render"));
  ({ validateLayoutForPublish } = await import("./publish-validation"));
  ({ documentLines } = await import("./lines"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

// ---------------------------------------------------------------------
// The richer condition vocabulary — "is set", "is not set", number
// comparisons, starts/ends with — on top of ==, !=, contains, includes,
// which must keep reading exactly as before.
// ---------------------------------------------------------------------

test("is set / is not set ask whether the field prints anything", () => {
  const { conditionMatches } = schema;
  assert.equal(conditionMatches("5", "is set", ""), true);
  assert.equal(conditionMatches("  ", "is set", ""), false);
  assert.equal(conditionMatches("", "is set", ""), false);
  assert.equal(conditionMatches("", "is not set", ""), true);
  assert.equal(conditionMatches("5", "is not set", ""), false);
});

test("is set reads inline, and the old != \"\" idiom still means the same", () => {
  const { applyConditionals } = schema;
  const readable = "{{if polybagQty is set}}QTY: {{polybagQty}} PCS{{endif}}";
  const idiom = '{{if polybagQty != ""}}QTY: {{polybagQty}} PCS{{endif}}';
  for (const value of ["5", ""]) {
    assert.equal(applyConditionals(readable, () => value), applyConditionals(idiom, () => value), value);
  }
  assert.equal(applyConditionals(readable, () => "5"), "QTY: {{polybagQty}} PCS");
  assert.equal(applyConditionals("{{if polybagQty is not set}}SINGLE{{else}}PACK{{endif}}", () => ""), "SINGLE");
  // Extra spaces inside a multi-word operator are fine.
  assert.equal(applyConditionals("{{if polybagQty is   not  set}}SINGLE{{endif}}", () => ""), "SINGLE");
});

test("number comparisons read amounts the way {{price}} does", () => {
  const { conditionMatches } = schema;
  assert.equal(conditionMatches("KR 129,95", ">", "100"), true);
  assert.equal(conditionMatches("79,00 DKK", ">", "100"), false);
  assert.equal(conditionMatches("79,00 DKK", "<", "100"), true);
  assert.equal(conditionMatches("100", ">=", "100"), true);
  assert.equal(conditionMatches("100", "<=", "99,5"), false);
  assert.equal(conditionMatches("1.299,95", ">", "1000"), true);
});

test("a value that isn't a number matches no comparison at all — never 0", () => {
  const { conditionMatches } = schema;
  for (const actual of ["", "See customer order", "99 SEK, 69 DKK"]) {
    assert.equal(conditionMatches(actual, ">", "0"), false, actual);
    assert.equal(conditionMatches(actual, "<", "1000"), false, actual);
  }
});

test("number comparisons parse inline, >= before >", () => {
  const { applyConditionals, conditionalsInLine } = schema;
  const [cond] = conditionalsInLine("{{if price >= 100}}BIG{{endif}}");
  assert.equal(cond.op, ">=");
  assert.equal(cond.value, "100");
  assert.equal(applyConditionals("{{if price > 100}}BIG{{else}}SMALL{{endif}}", () => "KR 69,95"), "SMALL");
  assert.equal(applyConditionals("{{if price>100}}BIG{{else}}SMALL{{endif}}", () => "KR 169,95"), "BIG");
});

test("starts with / ends with test the edges, case-insensitively", () => {
  const { conditionMatches, applyConditionals } = schema;
  assert.equal(conditionMatches("IL97261", "starts with", "il"), true);
  assert.equal(conditionMatches("IL97261", "starts with", "97"), false);
  assert.equal(conditionMatches("IL97261", "ends with", "261"), true);
  assert.equal(conditionMatches("IL97261", "!starts with", "IL"), false);
  assert.equal(conditionMatches("IL97261", "!ends with", "9"), true);
  // An empty search value matches nothing, as with contains.
  assert.equal(conditionMatches("IL97261", "starts with", ""), false);
  assert.equal(applyConditionals("{{if styleNumber starts with IL}}KIDS{{endif}}", () => "IL97261"), "KIDS");
});

test("the existing operators still parse and evaluate as before", () => {
  const { applyConditionals, conditionMatches } = schema;
  const eq = "{{if deliveryTerm == FOB}}{{customerOrderNo}}{{else}}{{poNumber}}{{endif}}";
  assert.equal(applyConditionals(eq, () => "fob"), "{{customerOrderNo}}");
  assert.equal(applyConditionals(eq, () => "DDP"), "{{poNumber}}");
  assert.equal(applyConditionals("{{if multipleStyles == true}}A{{else}}B{{endif}}", () => ""), "B");
  assert.equal(conditionMatches("Gift Set", "contains", "Set"), true);
  assert.equal(conditionMatches("GOTS", "includes", "GOT"), false);
});

test("validation: the new forms pass; a stray value or a non-number fails", () => {
  const { IF_RE, CONTROL_RE } = schema;
  const { validateLineConditionals } = tokenMetaMod;
  const v = (line: string) => validateLineConditionals(line, IF_RE, CONTROL_RE);
  assert.deepEqual(v("{{if polybagQty is set}}QTY{{endif}}"), []);
  assert.deepEqual(v("{{if price > 100}}A{{else}}B{{endif}}"), []);
  assert.deepEqual(v("{{if styleNumber !ends with 9}}A{{endif}}"), []);
  assert.match(v("{{if polybagQty is set 5}}QTY{{endif}}")[0], /takes no value/);
  assert.match(v("{{if price > lots}}A{{endif}}")[0], /needs a number/);
  assert.match(v("{{if nonsense is set}}A{{endif}}")[0], /unknown variable/);
});

test("conditionText writes a condition the way {{if}} reads it back", () => {
  const { conditionText, conditionalsInLine } = schema;
  for (const [field, op, value] of [
    ["polybagQty", "is set", ""],
    ["price", ">=", "100"],
    ["productGroup", "contains", "Gift Set"],
    ["customerItemNo", "!=", ""],
  ] as const) {
    const [cond] = conditionalsInLine(`{{if ${conditionText(field, op, value)}}}X{{endif}}`);
    assert.equal(cond.field, field);
    assert.equal(cond.op, op);
    assert.equal(cond.value, value);
  }
});

// ---------------------------------------------------------------------
// Block-level "Show only when…" — block.showWhen.
// ---------------------------------------------------------------------

function defWith(blocks: unknown[]) {
  return schema.LayoutDefSchema.parse({
    pages: [{ id: "p1", title: "", widthMm: 60, heightMm: 40, blocks }],
  });
}

const ALWAYS = { id: "b-always", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 2 }, lines: ["ALWAYS {{styleNumber}}"] };
const SET_ONLY = {
  id: "b-set",
  rect: { col: 0, row: 4, colSpan: 12, rowSpan: 2 },
  lines: ["SET ONLY {{customerItemNo}}"],
  showWhen: { match: "all", rules: [{ field: "productGroup", op: "contains", value: "Set" }] },
};

test("a block without rules always shows; an empty-field rule is inert", () => {
  const { blockShown } = schema;
  assert.equal(blockShown({}, () => ""), true);
  assert.equal(blockShown({ showWhen: { match: "all", rules: [] } }, () => ""), true);
  assert.equal(
    blockShown({ showWhen: { match: "all", rules: [{ field: "", op: "==", value: "x" }] } }, () => ""),
    true,
  );
});

test("all needs every rule, any needs one", () => {
  const { blockShown } = schema;
  const values: Record<string, string> = { productGroup: "Gift Set", polybagQty: "" };
  const rules = [
    { field: "productGroup", op: "contains" as const, value: "Set" },
    { field: "polybagQty", op: "is set" as const, value: "" },
  ];
  assert.equal(blockShown({ showWhen: { match: "all", rules } }, (f) => values[f] ?? ""), false);
  assert.equal(blockShown({ showWhen: { match: "any", rules } }, (f) => values[f] ?? ""), true);
});

test("showWhen round-trips through the schema and defaults op to is set", () => {
  const def = defWith([{ ...ALWAYS, showWhen: { rules: [{ field: "polybagQty" }] } }]);
  assert.deepEqual(def.pages[0].blocks[0].showWhen, {
    match: "all",
    rules: [{ field: "polybagQty", op: "is set", value: "" }],
  });
  // A block authored before showWhen existed has none.
  assert.equal(defWith([ALWAYS]).pages[0].blocks[0].showWhen, undefined);
});

test("render: the block prints only on styles its rules match", async () => {
  const def = defWith([ALWAYS, SET_ONLY]);
  const html = async (productGroup: string) =>
    renderLayoutHtml(def, { ...buildSampleStyleData(), productGroup }, { mode: "production" });
  const forSet = await html("Gift Set");
  assert.match(forSet, /ALWAYS/);
  assert.match(forSet, /SET ONLY/);
  const forSocks = await html("Socks");
  assert.match(forSocks, /ALWAYS/);
  assert.doesNotMatch(forSocks, /SET ONLY/);
  // The preview shows the true result too.
  const preview = await renderLayoutHtml(def, { ...buildSampleStyleData(), productGroup: "Socks" }, { mode: "preview" });
  assert.doesNotMatch(preview, /SET ONLY/);
});

test("readiness: a hidden block's fields are never waited on", () => {
  const def = defWith([ALWAYS, SET_ONLY]);
  // Not static — it depends on the style.
  assert.ok(!tokens.staticRequiredColumns(def).includes("customerItemNo"));
  assert.ok(tokens.staticRequiredColumns(def).includes("styleNumber"));
  assert.equal(tokens.defNeedsDynamicReadiness(def), true);
  const cols = (productGroup: string) =>
    tokens.layoutReadinessColumns(def, (col) => (col === "productGroup" ? productGroup : ""));
  assert.ok(cols("Gift Set").includes("customerItemNo"));
  assert.ok(!cols("Socks").includes("customerItemNo"));
});

test("unresolved + the reviewer's line list skip a hidden block", () => {
  const def = defWith([ALWAYS, SET_ONLY]);
  const socks = { ...buildSampleStyleData(), productGroup: "Socks", customerItemNo: "" };
  assert.ok(!tokens.unresolvedTokens(def, socks).includes("{{customerItemNo}}"));
  assert.ok(documentLines(def, socks, undefined).every((l) => l.blockId !== "b-set"));
  const set = { ...socks, productGroup: "Gift Set" };
  assert.ok(documentLines(def, set, undefined).some((l) => l.blockId === "b-set"));
});

test("publish: a rule on an unknown field or a missing number blocks publishing", () => {
  const bad = (rule: Record<string, string>) =>
    validateLayoutForPublish(defWith([{ ...ALWAYS, showWhen: { rules: [rule] } }]));
  const unknown = bad({ field: "nonsense", op: "is set" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? "" : unknown.details.join("\n"), /block b-always "Show only when": .*unknown variable/);
  const noNumber = bad({ field: "price", op: ">", value: "" });
  assert.equal(noNumber.ok, false);
  assert.equal(validateLayoutForPublish(defWith([ALWAYS, SET_ONLY])).ok, true);
});

test("showWhenText describes the rules in one phrase", () => {
  const { showWhenText } = schema;
  assert.equal(showWhenText({}), "");
  assert.equal(
    showWhenText({
      showWhen: {
        match: "any",
        rules: [
          { field: "productGroup", op: "contains", value: "Set" },
          { field: "polybagQty", op: "is set", value: "" },
        ],
      },
    }),
    "productGroup contains Set or polybagQty is set",
  );
});
