import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { StyleData } from "@/lib/pdf/types";

// See omit-empty-page.test.ts — the render module transitively constructs the
// db client at import time, so a dummy DATABASE_URL lets it load. Nothing
// here queries: repetitionStyles and the token resolvers are pure.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let pickSizeForm: typeof import("./size-form").pickSizeForm;
let sizeFormRun: typeof import("./size-form").sizeFormRun;
let splitSizeUnit: typeof import("./size-form").splitSizeUnit;
let resolveTextToken: typeof import("./tokens").resolveTextToken;
let repetitionStyles: typeof import("./render").repetitionStyles;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let validateTokenRef: typeof import("./token-meta").validateTokenRef;

before(async () => {
  ({ pickSizeForm, sizeFormRun, splitSizeUnit } = await import("./size-form"));
  ({ resolveTextToken } = await import("./tokens"));
  ({ repetitionStyles, renderLayoutHtml } = await import("./render"));
  ({ LayoutDefSchema } = await import("./schema"));
  ({ validateTokenRef } = await import("./token-meta"));
});

// ---------------------------------------------------------------------
// Two-form size labels — "86-92 cm / 1½-2 år". Which half a printed
// label shows is a per-output choice: {{sizeRangeCoop:numeric}} prints
// the centimetres, {{sizeRangeCoop:year}} the age, bare prints the label
// exactly as authored (so nothing already published moves).
// ---------------------------------------------------------------------

// The run as the buyer fills it — the case this exists for.
const COOP_RUN = [
  "86-92 cm / 1½-2 år",
  "98-104 cm / 3-4 år",
  "110-116 cm / 5-6 år",
  "122-128 cm / 7-8 år",
  "134-140 cm / 9-10 år",
];

function makeStyle(labels: string[] = COOP_RUN, over: Partial<StyleData> = {}): StyleData {
  return {
    styleName: "Base Style",
    styleNumber: "IL0001",
    customerName: "Coop DK",
    businessArea: "LICENSE",
    composition: [],
    productNameTranslations: [],
    washSymbols: [],
    sizes: labels.map((label, i) => ({ label, ean13: `570012345670${i}` })),
    carton: { klNumber: "", supplierNumber: "", lot: "", outerVE: 0, ean13: "" },
    ...over,
  };
}

const coop = (s: StyleData, arg?: string) => resolveTextToken(s, "sizeRangeCoop", arg);
const size = (s: StyleData, arg?: string) => resolveTextToken(s, "size", arg);

// ---- the picker ------------------------------------------------------

test("a two-form label splits into its measurement and its age", () => {
  assert.equal(pickSizeForm("86-92 cm / 1½-2 år", "numeric"), "86-92 cm");
  assert.equal(pickSizeForm("86-92 cm / 1½-2 år", "year"), "1½-2 år");
  // No form asked for ⇒ the label verbatim.
  assert.equal(pickSizeForm("86-92 cm / 1½-2 år", null), "86-92 cm / 1½-2 år");
});

test("a slash-joined size is NOT a two-form label — it survives both forms", () => {
  // The trap: "86/92" is one size written with a slash, not cm/age.
  for (const label of ["86/92", "23/26", "S", "4-5 ÅR", "110"]) {
    assert.equal(pickSizeForm(label, "numeric"), label, label);
    assert.equal(pickSizeForm(label, "year"), label, label);
  }
});

test("the measurement half keeps its own slashes and spacing", () => {
  assert.equal(pickSizeForm("86 / 92 cm / 1½-2 år", "numeric"), "86 / 92 cm");
  assert.equal(pickSizeForm("86 / 92 cm / 1½-2 år", "year"), "1½-2 år");
});

test("either half may come first", () => {
  assert.equal(pickSizeForm("1½-2 år / 86-92 cm", "numeric"), "86-92 cm");
  assert.equal(pickSizeForm("1½-2 år / 86-92 cm", "year"), "1½-2 år");
});

test("months and the English/German spellings count as an age", () => {
  assert.equal(pickSizeForm("62-68 cm / 3-6 mdr", "year"), "3-6 mdr");
  assert.equal(pickSizeForm("62-68 cm / 3-6 mdr", "numeric"), "62-68 cm");
  assert.equal(pickSizeForm("98-104 cm / 3-4 years", "year"), "3-4 years");
  assert.equal(pickSizeForm("98-104 cm / 3-4 Jahre", "numeric"), "98-104 cm");
  assert.equal(pickSizeForm("110-116 cm / 5-6 yrs", "year"), "5-6 yrs");
});

test("sizes that narrow onto the same text collapse to one entry", () => {
  const run = sizeFormRun(["86-92 cm / 1-2 år", "86-92 cm / 2-3 år", "98-104 cm / 3-4 år"], "numeric");
  assert.deepEqual(run.entries.map((e) => e.text), ["86/92", "98/104"]);
  // …and the collapsed entry remembers BOTH sizes, so the renderer can
  // still enlarge it for either repetition row.
  assert.deepEqual(run.entries[0].labels, ["86-92 cm / 1-2 år", "86-92 cm / 2-3 år"]);
});

test("no form ⇒ a plain 1:1 passthrough, duplicates and all", () => {
  const run = sizeFormRun(["86-92 cm / 1-2 år", "86-92 cm / 1-2 år"], null);
  assert.equal(run.entries.length, 2);
  assert.deepEqual(run.entries.map((e) => e.text), ["86-92 cm / 1-2 år", "86-92 cm / 1-2 år"]);
  assert.equal(run.joiner, " - ");
  assert.equal(run.unit, "");
});

// ---- numbers and unit taken apart ------------------------------------

test("a half splits into compacted numbers and its unit", () => {
  assert.deepEqual(splitSizeUnit("98-104 cm"), { value: "98/104", unit: "cm" });
  assert.deepEqual(splitSizeUnit("1½-2 år"), { value: "1½/2", unit: "år" });
  assert.deepEqual(splitSizeUnit("3-6 mdr"), { value: "3/6", unit: "mdr" });
  // Already slash-written, or written with spaces — one printed shape.
  assert.deepEqual(splitSizeUnit("86 / 92 cm"), { value: "86/92", unit: "cm" });
  // A single size keeps its single number.
  assert.deepEqual(splitSizeUnit("110 cm"), { value: "110", unit: "cm" });
  // No unit at all ⇒ numbers only, nothing to hoist.
  assert.deepEqual(splitSizeUnit("86/92"), { value: "86/92", unit: "" });
});

test("a half carrying TWO units is left exactly as authored", () => {
  // Compacting this would read as one four-part size; better odd than wrong.
  assert.deepEqual(splitSizeUnit("1½-2 år / 18-24 mdr"), {
    value: "1½-2 år / 18-24 mdr",
    unit: "",
  });
});

// ---- the token -------------------------------------------------------

test("{{sizeRangeCoop}} is unchanged — the labels as authored", () => {
  assert.equal(
    coop(makeStyle()),
    "86-92 cm / 1½-2 år - 98-104 cm / 3-4 år - 110-116 cm / 5-6 år - 122-128 cm / 7-8 år - 134-140 cm / 9-10 år",
  );
});

test("{{sizeRangeCoop:numeric}} prints the centimetres as one set, unit at the end", () => {
  assert.equal(coop(makeStyle(), "numeric"), "86/92-98/104-110/116-122/128-134/140 cm");
});

test("{{sizeRangeCoop:year}} prints the ages the same way", () => {
  assert.equal(coop(makeStyle(), "year"), "1½/2-3/4-5/6-7/8-9/10 år");
});

test("a unit is printed once, however many sizes carry it", () => {
  assert.equal(coop(makeStyle(["62-68 cm / 3-6 mdr", "74-80 cm / 9-12 mdr"]), "year"), "3/6-9/12 mdr");
  // …and a size that arrived WITHOUT the unit doesn't cost the run its own.
  assert.equal(coop(makeStyle(["98-104 cm / 3-4 år", "110-116", "122-128 cm / 7-8 år"]), "numeric"),
    "98/104-110/116-122/128 cm");
});

test("a run that genuinely mixes units keeps each one inline", () => {
  // Months and years in the same column — a single trailing unit would be a
  // lie, so each entry carries its own.
  assert.equal(coop(makeStyle(["62-68 cm / 3-6 mdr", "98-104 cm / 3-4 år"]), "year"), "3/6 mdr-3/4 år");
});

test("a run without an age half prints the same for every form", () => {
  const style = makeStyle(["86/92", "98/104", "110/116"]);
  // Bare is the passthrough it always was; a form still sets the run.
  assert.equal(coop(style), "86/92 - 98/104 - 110/116");
  assert.equal(coop(style, "numeric"), "86/92-98/104-110/116");
  assert.equal(coop(style, "year"), "86/92-98/104-110/116");
});

test("the whole run prints on every repetition, in the chosen form", () => {
  const reps = repetitionStyles(makeStyle(), "size");
  assert.equal(reps.length, 5);
  for (const rep of reps) {
    assert.equal(coop(rep, "year"), "1½/2-3/4-5/6-7/8-9/10 år");
  }
});

// ---- {{size}} in a chosen form -----------------------------------------

test("{{size}} is unchanged — the current row's label as authored", () => {
  assert.equal(size(makeStyle()), "86-92 cm / 1½-2 år");
});

test("{{size:numeric}} / {{size:year}} print one half of the current row's size", () => {
  assert.equal(size(makeStyle(), "numeric"), "86/92 cm");
  assert.equal(size(makeStyle(), "year"), "1½/2 år");
});

test("{{size:numeric}} follows the repetition, not just the first size", () => {
  const rows = repetitionStyles(makeStyle(), "size");
  assert.equal(size(rows[1], "numeric"), "98/104 cm");
  assert.equal(size(rows[1], "year"), "3/4 år");
});

test("{{size:numeric}} on a run without an age half prints the plain size", () => {
  const style = makeStyle(["86/92", "98/104", "110/116"]);
  assert.equal(size(style), "86/92");
  assert.equal(size(style, "numeric"), "86/92");
  assert.equal(size(style, "year"), "86/92");
});

test("on the assortment row, {{size:numeric}} sets the whole run like sizeRangeCoop", () => {
  const style = makeStyle(COOP_RUN, { isAssortment: true, allSizes: makeStyle().sizes });
  assert.equal(size(style), "86-92 cm / 1½-2 år-98-104 cm / 3-4 år-110-116 cm / 5-6 år-122-128 cm / 7-8 år-134-140 cm / 9-10 år");
  assert.equal(size(style, "numeric"), "86/92-98/104-110/116-122/128-134/140 cm");
  assert.equal(size(style, "year"), "1½/2-3/4-5/6-7/8-9/10 år");
});

// ---- the render (the enlarged current size) --------------------------

function defWith(line: string) {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 100,
        heightMm: 60,
        blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 3 }, fontPt: 9, lines: [line] }],
      },
    ],
  });
}

// The printed range, with the enlarged entry marked «like this».
function printedRange(html: string): string {
  const body = /<div class="ol-line">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(body, "expected a rendered line");
  return body[1].replace(/<span class="ol-size-current">([\s\S]*?)<\/span>/g, "«$1»");
}

test("the current repetition's size is enlarged in the chosen form", async () => {
  const rows = repetitionStyles(makeStyle(), "size");
  const html = await renderLayoutHtml(defWith("{{sizeRangeCoop:year}}"), rows[1], {
    mode: "production",
  });
  // The shared unit sits OUTSIDE the enlarged span — it belongs to the whole
  // run, not to the size being called out.
  assert.equal(printedRange(html), "1½/2-«3/4»-5/6-7/8-9/10 år");
});

test("a collapsed entry is enlarged for either size behind it", async () => {
  const style = makeStyle(["86-92 cm / 1-2 år", "86-92 cm / 2-3 år", "98-104 cm / 3-4 år"]);
  const rows = repetitionStyles(style, "size");
  for (const row of rows.slice(0, 2)) {
    const html = await renderLayoutHtml(defWith("{{sizeRangeCoop:numeric}}"), row, {
      mode: "production",
    });
    assert.equal(printedRange(html), "«86/92»-98/104 cm");
  }
});

test("bare {{sizeRangeCoop}} renders exactly as before", async () => {
  const rows = repetitionStyles(makeStyle(["86/92", "98/104", "110/116"]), "size");
  const html = await renderLayoutHtml(defWith("{{sizeRangeCoop}}"), rows[0], { mode: "production" });
  assert.equal(printedRange(html), "«86/92» - 98/104 - 110/116");
});

// ---- publish validation ---------------------------------------------

test("publish accepts the two forms and rejects anything else", () => {
  assert.deepEqual(validateTokenRef("sizeRangeCoop"), []);
  assert.deepEqual(validateTokenRef("sizeRangeCoop", "numeric"), []);
  assert.deepEqual(validateTokenRef("sizeRangeCoop", "year"), []);
  const errs = validateTokenRef("sizeRangeCoop", "cm");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /size form must be/);
});

test("{{size}} accepts the same two forms and rejects anything else", () => {
  assert.deepEqual(validateTokenRef("size"), []);
  assert.deepEqual(validateTokenRef("size", "numeric"), []);
  assert.deepEqual(validateTokenRef("size", "year"), []);
  const errs = validateTokenRef("size", "cm");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /size form must be/);
});
