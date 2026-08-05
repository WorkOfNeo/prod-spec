import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load (nothing here queries).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let conditionMatches: typeof import("./schema").conditionMatches;
let conditionalsInLine: typeof import("./schema").conditionalsInLine;
let applyConditionals: typeof import("./schema").applyConditionals;
let IF_RE: typeof import("./schema").IF_RE;
let CONTROL_RE: typeof import("./schema").CONTROL_RE;
let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let validateLineConditionals: typeof import("./token-meta").validateLineConditionals;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ conditionMatches, conditionalsInLine, applyConditionals, IF_RE, CONTROL_RE, LayoutDefSchema } =
    await import("./schema"));
  ({ validateLineConditionals } = await import("./token-meta"));
  ({ renderLayoutHtml } = await import("./render"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

// ---------------------------------------------------------------------
// {{if field contains VALUE}} — a plain substring test, the operator a
// messy taxonomy needs. The case it was built for: Monday's Product
// Group decides whether a price label reads "PER SÆT" or "KR.", and the
// column says "Set", "Gift Set" or "SET 2-PACK" depending on the style.
//
//   {{if productGroup contains Set}}PER SÆT{{else}}KR.{{endif}}
//
// == is still there for "the value must be the WHOLE field", and
// includes for comma-separated lists — this sits between them.
// ---------------------------------------------------------------------

const SET_LINE = "{{if productGroup contains Set}}PER SÆT{{else}}KR.{{endif}}";

test("contains matches the word anywhere in the field, case-insensitively", () => {
  for (const value of ["Set", "set", "Gift Set", "SET 2-PACK", "Baby set 3 pcs"]) {
    assert.equal(conditionMatches(value, "contains", "Set"), true, value);
  }
});

test("contains does not match a field that never mentions it", () => {
  for (const value of ["Socks", "3-Pack Socks", "T-Shirt", ""]) {
    assert.equal(conditionMatches(value, "contains", "Set"), false, value);
  }
});

test("!contains is the exact negation", () => {
  assert.equal(conditionMatches("Gift Set", "!contains", "Set"), false);
  assert.equal(conditionMatches("Socks", "!contains", "Set"), true);
});

test("an empty search value matches nothing (as with includes)", () => {
  assert.equal(conditionMatches("Gift Set", "contains", ""), false);
  assert.equal(conditionMatches("Gift Set", "!contains", ""), true);
});

test("contains is a SUPERSET of what == and includes catch", () => {
  // "Gift Set" is not equal to "Set", and as a one-item list it isn't a
  // member match either — the gap contains fills.
  assert.equal(conditionMatches("Gift Set", "==", "Set"), false);
  assert.equal(conditionMatches("Gift Set", "includes", "Set"), false);
  assert.equal(conditionMatches("Gift Set", "contains", "Set"), true);
  // …and == still means the whole field, for when that's what you want.
  assert.equal(conditionMatches("Set", "==", "Set"), true);
});

test("the line parses as one conditional with both branches", () => {
  const [cond] = conditionalsInLine(SET_LINE);
  assert.equal(cond.field, "productGroup");
  assert.equal(cond.op, "contains");
  assert.equal(cond.value, "Set");
  assert.equal(cond.ifBody, "PER SÆT");
  assert.equal(cond.elseBody, "KR.");
});

test("the price label switches on the product group", () => {
  const forGroup = (group: string) => applyConditionals(SET_LINE, () => group);
  assert.equal(forGroup("Set"), "PER SÆT");
  assert.equal(forGroup("Gift Set"), "PER SÆT");
  assert.equal(forGroup("SET 2-PACK"), "PER SÆT");
  assert.equal(forGroup("Socks"), "KR.");
  assert.equal(forGroup(""), "KR.");
});

test("!contains reads the other way round", () => {
  const line = "{{if productGroup !contains Set}}KR.{{else}}PER SÆT{{endif}}";
  assert.equal(applyConditionals(line, () => "Socks"), "KR.");
  assert.equal(applyConditionals(line, () => "Gift Set"), "PER SÆT");
});

test("a quoted multi-word value survives the parse", () => {
  const line = '{{if description contains "2 pack"}}2-PACK{{endif}}';
  assert.equal(applyConditionals(line, () => "Socks 2 Pack Navy"), "2-PACK");
  assert.equal(applyConditionals(line, () => "Socks Navy"), "");
});

test("the existing operators are untouched", () => {
  const eq = "{{if deliveryTerm == FOB}}{{customerOrderNo}}{{else}}{{poNumber}}{{endif}}";
  assert.equal(applyConditionals(eq, () => "FOB"), "{{customerOrderNo}}");
  assert.equal(applyConditionals(eq, () => "DDP"), "{{poNumber}}");
  const inc = "{{if certificates includes FSC}}FSC certified{{endif}}";
  assert.equal(applyConditionals(inc, () => "FSC, OEKO-TEX"), "FSC certified");
  assert.equal(applyConditionals(inc, () => "OEKO-TEX"), "");
  // includes stays a per-ITEM match, NOT a substring one — that distinction
  // is the reason contains had to be added rather than loosening includes.
  assert.equal(conditionMatches("GOTS", "includes", "GOT"), false);
});

test("publish validation accepts contains and still catches an orphan", () => {
  assert.deepEqual(validateLineConditionals(SET_LINE, IF_RE, CONTROL_RE), []);
  assert.deepEqual(
    validateLineConditionals(
      "{{if productGroup !contains Set}}KR.{{endif}}",
      IF_RE,
      CONTROL_RE,
    ),
    [],
  );
  const errs = validateLineConditionals("{{if productGroup contains Set}}PER SÆT", IF_RE, CONTROL_RE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /malformed conditional/);
});

test("end to end: the label prints PER SÆT for a set and KR. for a single", async () => {
  const def = LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 60,
        heightMm: 40,
        blocks: [
          {
            id: "b1",
            rect: { col: 0, row: 0, colSpan: 12, rowSpan: 3 },
            fontPt: 9,
            lines: [`{{price}} ${SET_LINE}`],
          },
        ],
      },
    ],
  });
  const printed = async (productGroup: string) => {
    const html = await renderLayoutHtml(
      def,
      { ...buildSampleStyleData(), productGroup, price: { amount: 79, currency: "DKK" } },
      { mode: "production" },
    );
    return /<div class="ol-line">([\s\S]*?)<\/div>/.exec(html)![1];
  };
  assert.equal(await printed("Set"), "79.00 DKK PER SÆT");
  assert.equal(await printed("Gift Set"), "79.00 DKK PER SÆT");
  assert.equal(await printed("3-Pack Socks"), "79.00 DKK KR.");
});
