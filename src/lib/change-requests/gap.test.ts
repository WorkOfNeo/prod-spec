import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { GapDeclaration } from "./types";
import type { ToolContext } from "./agent/contract";

// The pure half of the gap check: the token catalogue and its filter, the
// argument variants list_tokens resolves, the code spec / build prompt the
// developer gets, the developer email, and the declare_gap refusal for a
// token that already exists (which returns before any database call). The DB
// half (declareGap's writes, resumeAwaitingCode) is covered with mocks in
// tests/change-request-tools.test.ts. gap.ts constructs the db client at
// import time, so a dummy DATABASE_URL lets it load; nothing here queries.
// Fixtures are synthetic.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let gap: typeof import("./gap");
let LAYOUT_TOKENS: typeof import("@/lib/output-layouts/token-meta").LAYOUT_TOKENS;
let changeRequestNeedsCodeEmail: typeof import("@/lib/email/templates/change-request-needs-code").changeRequestNeedsCodeEmail;
let CodeSpecSchema: typeof import("./types").CodeSpecSchema;

before(async () => {
  gap = await import("./gap");
  ({ LAYOUT_TOKENS } = await import("@/lib/output-layouts/token-meta"));
  ({ changeRequestNeedsCodeEmail } = await import("@/lib/email/templates/change-request-needs-code"));
  ({ CodeSpecSchema } = await import("./types"));
});

const DECL: GapDeclaration = {
  tokenKey: "bogusPackQty",
  label: "Pieces per bogus pack",
  source: {
    board: "Pre-Order",
    column: "Bogus Packing (text_bogus1)",
    examples: [
      { value: "Bogus pack - 3 Pcs", count: 12 },
      { value: "Single bogus pack", count: 40 },
      { value: "Bogus pack - 6 Pcs", count: 7 },
    ],
  },
  rule: "Print the number of pieces in one bogus pack when it is more than one; print nothing otherwise.",
  cases: [
    { input: "Bogus pack - 3 Pcs", output: "3" },
    { input: "Bogus pack - 6 Pcs", output: "6" },
    { input: "Single bogus pack", output: "" },
  ],
};

const CTX = { requestNumber: 42, outputLabel: "Bogus polybag sticker", layoutName: "Bogus sticker 50x60" };

// ── Catalogue ───────────────────────────────────────────────────────────────

test("tokenCatalogue: no query lists every layout token with its metadata", () => {
  const all = gap.tokenCatalogue();
  assert.equal(all.length, LAYOUT_TOKENS.length);
  const polybag = all.find((t) => t.key === "polybagQty");
  assert.ok(polybag);
  assert.equal(polybag.group, "Order & carton");
  assert.equal(polybag.kind, "text");
  assert.equal(polybag.example, "5");
  const composition = all.find((t) => t.key === "composition");
  assert.equal(composition?.arg, "lang");
  // Blank queries are the same as none.
  assert.equal(gap.tokenCatalogue("   ").length, all.length);
});

test("tokenCatalogue: every query word must match key, label, group or example (case-insensitive)", () => {
  assert.deepEqual(
    gap.tokenCatalogue("POLYBAG").map((t) => t.key),
    ["polybagQty"],
  );
  const carton = gap.tokenCatalogue("carton qty").map((t) => t.key);
  assert.ok(carton.includes("qtyPerCarton"), carton.join(","));
  assert.ok(!carton.includes("styleName"));
  // A group name matches too.
  const perLanguage = gap.tokenCatalogue("per language").map((t) => t.key);
  assert.ok(perLanguage.includes("careInstructions"));
  assert.ok(perLanguage.every((k) => LAYOUT_TOKENS.find((t) => t.key === k)?.group === "Per language"));
  assert.deepEqual(gap.tokenCatalogue("bogus-no-such-token"), []);
});

test("tokenExists: static keys and sibling slot keys exist, made-up keys don't", () => {
  assert.equal(gap.tokenExists("polybagQty"), true);
  assert.equal(gap.tokenExists("style2Name"), true);
  assert.equal(gap.tokenExists("bogusPackQty"), false);
});

test("tokenArgVariants: the text arguments list_tokens resolves next to the bare value", () => {
  assert.deepEqual([...gap.tokenArgVariants({ arg: "cartonKind" })], ["solid", "assort", "inner", "outer"]);
  assert.deepEqual([...gap.tokenArgVariants({ arg: "orderKind" })], ["solid", "assort"]);
  assert.deepEqual([...gap.tokenArgVariants({ arg: "sizeForm" })], ["numeric", "year"]);
  assert.deepEqual([...gap.tokenArgVariants({ arg: "sizeJoin" })], ["dash"]);
  assert.deepEqual([...gap.tokenArgVariants({ arg: "itemNoSource" })], ["product", "carton"]);
  // Languages are resolved per language; graphics arguments not at all.
  assert.deepEqual([...gap.tokenArgVariants({ arg: "lang" })], []);
  assert.deepEqual([...gap.tokenArgVariants({ arg: "source" })], []);
  assert.deepEqual([...gap.tokenArgVariants({})], []);
});

// ── Code spec ───────────────────────────────────────────────────────────────

test("buildCodeSpec: the declaration plus a build prompt with every key fact", () => {
  const spec = gap.buildCodeSpec(DECL, CTX);
  assert.ok(CodeSpecSchema.safeParse(spec).success);
  assert.equal(spec.tokenKey, DECL.tokenKey);
  assert.deepEqual(spec.cases, DECL.cases);
  const p = spec.buildPrompt;

  // Where, what, for which request.
  assert.match(p, /WorkOfNeo\/prod-spec/);
  assert.match(p, /\{\{bogusPackQty\}\}/);
  assert.match(p, /Pieces per bogus pack/);
  assert.match(p, /R-0042 \(Bogus polybag sticker\)/);
  assert.match(p, /"Bogus sticker 50x60"/);
  assert.ok(p.includes(DECL.rule));

  // The source with live examples and counts, biggest first.
  assert.match(p, /Monday board: Pre-Order/);
  assert.match(p, /Column: Bogus Packing \(text_bogus1\)/);
  assert.match(p, /59 styles counted/);
  const single = p.indexOf('"Single bogus pack" × 40');
  const three = p.indexOf('"Bogus pack - 3 Pcs" × 12');
  const six = p.indexOf('"Bogus pack - 6 Pcs" × 7');
  assert.ok(single > 0 && three > single && six > three, "examples sorted by count");

  // The cases, an empty output shown as prints-nothing.
  assert.match(p, /"Bogus pack - 3 Pcs" → "3"/);
  assert.match(p, /"Single bogus pack" → "" \(prints nothing\)/);

  // The files, in order.
  assert.match(p, /src\/lib\/output-layouts\/token-meta\.ts — add an entry to LAYOUT_TOKENS: \{ key: "bogusPackQty"/);
  assert.match(p, /example: "3"/);
  assert.match(p, /src\/lib\/output-layouts\/tokens\.ts — add the resolver to RESOLVERS/);
  assert.match(p, /DEFAULT_COLUMN_MAPPING/);
  assert.match(p, /mapMondayItemToStyleData/);
  // A blank case exists, so REQUIRED_COLUMNS must stay out of it.
  assert.match(p, /REQUIRED_COLUMNS in tokens\.ts — leave \{\{bogusPackQty\}\} OUT/);

  // Smoke test batch + done criteria + the resume promise.
  assert.match(p, /src\/lib\/output-layouts\/bogusPackQty\.test\.ts/);
  assert.match(p, /scripts\/ol-smoke-test\.ts/);
  assert.match(p, /\{\{if bogusPackQty != ""\}\}…\{\{endif\}\}/);
  assert.match(p, /npx tsc --noEmit/);
  assert.match(p, /npx next build/);
  assert.match(p, /When this is merged and deployed, Prod-Spec picks R-0042 up again by itself\./);
});

test("buildCodeSpec: no blank case → REQUIRED_COLUMNS only if blank is not valid; no layout name, no examples", () => {
  const decl: GapDeclaration = {
    ...DECL,
    source: { ...DECL.source, examples: [] },
    cases: [{ input: "Bogus pack - 3 Pcs", output: "3" }],
  };
  assert.equal(gap.blankIsValid(decl), false);
  assert.equal(gap.blankIsValid(DECL), true);
  const p = gap.buildCodeSpec(decl, { requestNumber: 7, outputLabel: "Bogus label" }).buildPrompt;
  assert.match(p, /REQUIRED_COLUMNS in tokens\.ts — add \{\{bogusPackQty\}\} with its column only if a style without this value must not print/);
  assert.match(p, /No live examples were recorded/);
  assert.match(p, /R-0007 \(Bogus label\) can print it/);
  assert.doesNotMatch(p, /on the layout/);
  assert.match(p, /validateTokenRef\("bogusPackQty"\)/);
});

test("buildPromptPath: the build-prompt page for one output", () => {
  assert.equal(gap.buildPromptPath("bogus-req", "bogus-out"), "/requests/bogus-req/build-prompt?output=bogus-out");
});

// ── declare_gap refusal ─────────────────────────────────────────────────────

test("declareGap: refuses a token that already exists, before touching anything", async () => {
  const logs: unknown[] = [];
  const ctx: ToolContext = {
    requestId: "bogus-req",
    outputId: "bogus-out",
    userId: null,
    log: async (s) => {
      logs.push(s);
    },
  };
  const res = await gap.declareGap(ctx, { ...DECL, tokenKey: "polybagQty" });
  assert.equal(res.isError, true);
  const content = res.content as { error: string; token: { key: string } };
  assert.match(content.error, /\{\{polybagQty\}\} already exists/);
  assert.match(content.error, /Use it/);
  assert.equal(content.token.key, "polybagQty");
  // A dynamic sibling key counts as existing too.
  const sibling = await gap.declareGap(ctx, { ...DECL, tokenKey: "style3Name" });
  assert.equal(sibling.isError, true);
  assert.deepEqual(logs, []);
});

// ── Developer email ─────────────────────────────────────────────────────────

test("needs-code email: subject, what/where/why, examples with counts, the build-prompt button", () => {
  const url = "https://prod-spec.example.com/requests/bogus-req/build-prompt?output=bogus-out&x=1";
  const mail = changeRequestNeedsCodeEmail({
    ...CTX,
    tokenKey: DECL.tokenKey,
    label: DECL.label,
    rule: DECL.rule,
    source: DECL.source,
    buildPromptUrl: url,
  });
  assert.equal(mail.subject, "Variable needed: {{bogusPackQty}} · blocks R-0042 (Bogus polybag sticker)");
  for (const body of [mail.html, mail.text]) {
    assert.match(body, /Pieces per bogus pack/);
    assert.match(body, /Pre-Order › Bogus Packing \(text_bogus1\)/);
    assert.match(body, /Single bogus pack/);
    assert.match(body, /× 40/);
    assert.match(body, /Why a variable/);
    assert.match(body, /picks R-0042 up again by itself/);
  }
  assert.match(mail.html, /max-width: 480px/);
  assert.match(mail.html, /Get build prompt/);
  // The link is HTML-escaped in the attribute; plain in the text part.
  assert.ok(mail.html.includes('href="https://prod-spec.example.com/requests/bogus-req/build-prompt?output=bogus-out&amp;x=1"'));
  assert.ok(mail.text.includes(`Get build prompt: ${url}`));
});

test("needs-code email: escapes HTML and caps the example list", () => {
  const mail = changeRequestNeedsCodeEmail({
    tokenKey: "bogusKey",
    label: "<b>label</b>",
    rule: "a < b & c",
    source: {
      board: "B",
      column: "C",
      examples: Array.from({ length: 11 }, (_, i) => ({ value: `v${i}`, count: 100 - i })),
    },
    requestNumber: 1,
    outputLabel: "Out",
    buildPromptUrl: "https://example.com/x",
  });
  assert.ok(!mail.html.includes("<b>label</b>"));
  assert.ok(mail.html.includes("&lt;b&gt;label&lt;/b&gt;"));
  assert.ok(mail.html.includes("a &lt; b &amp; c"));
  assert.ok(mail.html.includes("v7"));
  assert.ok(!mail.html.includes(">v8<"));
  assert.match(mail.html, /and 3 more in the build prompt/);
});
