// Bench case files: every shipped case validates, and the schema catches the
// mistakes a hand-written case makes (a typo in a style override, a control
// style that doesn't exist, a gap case with no token, a block off the grid).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";
import {
  BenchCaseSchema,
  applyStyleOverrides,
  benchStyleData,
  loadBenchCases,
  overrideKeyError,
  parseBenchCase,
  representativeStyle,
} from "./case-schema";

const CASES = resolve(__dirname, "../../../../scripts/cr-bench/cases");
const rawCase = (name: string) => JSON.parse(readFileSync(`${CASES}/${name}.json`, "utf8"));

test("every shipped case file validates", () => {
  const loaded = loadBenchCases(CASES);
  const ids = loaded.map((l) => l.case.id);
  for (const id of ["polybag-qty", "polybag-qty-gap", "socks-composition"]) assert.ok(ids.includes(id), `case ${id}`);
  for (const { case: c } of loaded) {
    // parseLayoutDef ran: every block carries the id the agent addresses.
    for (const page of c.layout.definition.pages) for (const b of page.blocks) assert.ok(b.id, `${c.id}: block without id`);
    for (const s of c.styles) assert.ok(benchStyleData(c, s.id).styleNumber, `${c.id}/${s.id}`);
    assert.ok(c.styles.some((s) => s.group === "control"), `${c.id} has a control style`);
  }
});

test("the shipped cases say what the brief asks", () => {
  const byId = new Map(loadBenchCases(CASES).map((l) => [l.case.id, l.case]));
  const qty = byId.get("polybag-qty")!;
  assert.equal(qty.layout.definition.pages[0].widthMm, 50);
  assert.equal(qty.layout.definition.pages[0].gridCols, 50);
  assert.equal(qty.layout.definition.pages[0].gridRows, 60);
  assert.deepEqual(qty.expected.block, {
    page: 0,
    rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 },
    tolerance: 12,
    lineIncludes: ["polybagQty"],
  });
  assert.deepEqual(qty.expected.tokensUsed, ["polybagQty"]);
  assert.equal(representativeStyle(qty).id, "style-5pcs");

  const gap = byId.get("polybag-qty-gap")!;
  assert.deepEqual(gap.removeTokens, ["polybagQty"]);
  assert.deepEqual(gap.expected, { verdict: "gap", gapTokenKey: "polybagQty" });

  const socks = byId.get("socks-composition")!;
  assert.deepEqual(socks.expected.mustNotChangeStyleIds, ["style-tee"]);
  assert.ok(socks.expected.tokensUsed?.includes("productGroup"));
  assert.ok(socks.expected.tokensUsed?.includes("washSymbols"));
});

test("cases stay synthetic: placeholder EANs and PO numbers only", () => {
  const text = loadBenchCases(CASES)
    .map((l) => readFileSync(l.file, "utf8"))
    .join("\n");
  // Every EAN is a restricted-circulation (prefix 2) number, never a real GS1 product code.
  for (const ean of text.match(/\b\d{13}\b/g) ?? []) assert.ok(ean.startsWith("2"), `EAN ${ean} is not a synthetic 2xx code`);
  for (const po of text.match(/PO-\d+/g) ?? []) assert.match(po, /^PO-000\d$/);
});

test("schema: rejects a style override that isn't one", () => {
  const raw = rawCase("polybag-qty");
  raw.styles[0].values.polybagQty = "5";
  assert.throws(() => parseBenchCase(raw), /styles\.0\.values\.polybagQty: "polybagQty" is not a style override/);
  assert.match(overrideKeyError("composition:finnish") ?? "", /two-letter/);
  assert.equal(overrideKeyError("carton.klNumber"), null);
  assert.equal(overrideKeyError("productName:sv"), null);
});

test("schema: cross-field checks", () => {
  type Raw = {
    styles: { id: string; values: Record<string, string> }[];
    expected: { verdict: string; mustNotChangeStyleIds?: string[]; block: { page: number; rect: { col: number } } };
    removeTokens?: string[];
    images?: string[];
    layout: { definition: unknown };
  };
  const bad = (mutate: (raw: Raw) => void, message: RegExp) => {
    const raw = rawCase("polybag-qty");
    mutate(raw);
    const r = BenchCaseSchema.safeParse(raw);
    assert.equal(r.success, false);
    assert.match(r.error!.issues.map((i) => i.message).join(" | "), message);
  };
  bad((r) => (r.expected.mustNotChangeStyleIds = ["style-nope"]), /no style "style-nope"/);
  bad((r) => (r.styles[1].id = r.styles[0].id), /duplicate style id/);
  bad((r) => (r.removeTokens = ["polybagQuantity"]), /unknown token "polybagQuantity"/);
  bad((r) => (r.expected = { verdict: "gap" } as Raw["expected"]), /needs gapTokenKey/);
  bad((r) => (r.expected.block.rect.col = 40), /runs past the 50×60 grid/);
  bad((r) => (r.expected.block.page = 3), /no page 3/);
  bad((r) => (r.images = ["/abs/shot.png"]), /relative to the case file/);
  bad((r) => (r.layout.definition = { nope: true }), /layout definition with pages/);
  bad((r) => (r.styles[0].values.price = "cheap"), /must be a number/);
  bad((r) => (r.styles[0].values.sizes = "S=123"), /must be 13 digits/);
});

test("applyStyleOverrides: raw fields, nested paths, languages, lists, sizes and price", () => {
  const s = applyStyleOverrides(buildSampleStyleData(), {
    trimsRaw: "Solid polybag- 5 Pcs / Polybag",
    "colour.name": "Black",
    "carton.klNumber": "KL-1",
    "composition:fi": "80% Puuvilla",
    "composition:de": "",
    washSymbols: "wash40, bleach_no",
    certificates: "",
    sizes: "98/104=2000000100012, 110/116",
    price: "9,95",
    "price.currency": "",
  });
  assert.equal(s.trimsRaw, "Solid polybag- 5 Pcs / Polybag");
  assert.equal(s.colour?.name, "Black");
  assert.equal(s.colour?.code, "NVY-300", "the other half of colour stays");
  assert.equal(s.carton.klNumber, "KL-1");
  assert.equal(s.composition.find((x) => x.language === "fi")?.text, "80% Puuvilla");
  assert.equal(s.composition.some((x) => x.language === "de"), false);
  assert.deepEqual(s.washSymbols, ["wash40", "bleach_no"]);
  assert.deepEqual(s.certificates, []);
  assert.deepEqual(s.sizes, [
    { label: "98/104", ean13: "2000000100012" },
    { label: "110/116", ean13: "" },
  ]);
  assert.equal(s.carton.perSize, undefined, "the sample's per-size cartons don't survive a new size run");
  assert.deepEqual(s.price, { amount: 9.95 });
  // The sample itself is untouched.
  assert.equal(buildSampleStyleData().composition.some((x) => x.language === "de"), true);
});
