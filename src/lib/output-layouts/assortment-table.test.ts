import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load (nothing here queries).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ LayoutDefSchema } = await import("./schema"));
  ({ renderLayoutHtml } = await import("./render"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

function defWith(lines: string[], repeatBy?: "size" | "ean") {
  return LayoutDefSchema.parse({
    ...(repeatBy ? { settings: { repeatBy } } : {}),
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 210,
        heightMm: 100,
        blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 6 }, fontPt: 9, lines }],
      },
    ],
  });
}

// Cells of the assortment table, in document order: the header row's size
// labels then the qty row's values.
function cells(html: string): { head: string[]; qty: string[] } {
  const table = /<table class="ol-assort">([\s\S]*?)<\/table>/.exec(html);
  if (!table) return { head: [], qty: [] };
  const rows = [...table[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((r) => r[1]);
  const strip = (row: string) =>
    [...row.matchAll(/<t[hd](?: class="ol-assort-lbl")?>([\s\S]*?)<\/t[hd]>/g)]
      .map((m) => m[1])
      .slice(1); // drop the leading "Size" / "Qty" label cell
  return { head: strip(rows[0] ?? ""), qty: strip(rows[1] ?? "") };
}

const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];

test("{{assortmentTable}} draws sizes across the top with the ratio underneath", async () => {
  const html = await renderLayoutHtml(defWith(["{{assortmentTable}}"]), buildSampleStyleData());
  const { head, qty } = cells(html);
  // The sample style's run and its "1,2,3,3,2,1" ratio.
  assert.deepEqual(head, SIZES);
  assert.deepEqual(qty, ["1", "2", "3", "3", "2", "1"]);
  // The row labels the approved design carries.
  assert.ok(html.includes(`<th class="ol-assort-lbl">Size</th>`), "size row label");
  assert.ok(html.includes(`<th class="ol-assort-lbl">Qty</th>`), "qty row label");
});

test("labelled totals reduce to a ratio in the rendered table", async () => {
  const style = { ...buildSampleStyleData(), sizeRatioRaw: "XS-1000, S-2000, M-3000, L-3000, XL-2000, XXL-1000" };
  const { qty } = cells(await renderLayoutHtml(defWith(["{{assortmentTable}}"]), style));
  assert.deepEqual(qty, ["1", "2", "3", "3", "2", "1"]);
});

test("a Solid/Assort cell prints the ASSORT run", async () => {
  const style = {
    ...buildSampleStyleData(),
    sizeRatioRaw: "Solid - 60, 180, 270, 270, 180, 60. Assort - 1,2,4,4,2,1",
  };
  const { qty } = cells(await renderLayoutHtml(defWith(["{{assortmentTable}}"]), style));
  assert.deepEqual(qty, ["1", "2", "4", "4", "2", "1"]);
});

test("a size the buyer gave no ratio renders an empty cell, keeping columns aligned", async () => {
  const style = { ...buildSampleStyleData(), sizeRatioRaw: "XS-1, S-2, M-3" };
  const { head, qty } = cells(await renderLayoutHtml(defWith(["{{assortmentTable}}"]), style));
  assert.deepEqual(head, SIZES, "every size keeps its column");
  assert.deepEqual(qty, ["1", "2", "3", "", "", ""]);
});

test("the table prints the WHOLE run on every row of a per-size repeat", async () => {
  // The assortment describes the pack, not the row — so narrowing must not
  // reduce it to the current size. One table per repetition, all identical.
  const html = await renderLayoutHtml(defWith(["{{size}}", "{{assortmentTable}}"], "size"), buildSampleStyleData());
  const tables = [...html.matchAll(/<table class="ol-assort">/g)];
  assert.equal(tables.length, SIZES.length, "one table per size repetition");
  for (const m of html.matchAll(/<table class="ol-assort">([\s\S]*?)<\/table>/g)) {
    const { head } = cells(`<table class="ol-assort">${m[1]}</table>`);
    assert.deepEqual(head, SIZES, "every repetition shows the full run");
  }
});

test("no ratio on the style ⇒ no table, and the token-only line drops in production", async () => {
  const style = { ...buildSampleStyleData(), sizeRatioRaw: undefined };
  const html = await renderLayoutHtml(defWith(["{{assortmentTable}}"]), style, { mode: "production" });
  // The stylesheet always carries the .ol-assort rules — it's the MARKUP
  // that must be absent.
  assert.ok(
    !html.includes(`<table class="ol-assort">`),
    "no empty table shell on a style with no ratio",
  );
});

test("no ratio ⇒ an amber chip in the builder preview, not silence", async () => {
  const style = { ...buildSampleStyleData(), sizeRatioRaw: undefined };
  const html = await renderLayoutHtml(defWith(["{{assortmentTable}}"]), style, { mode: "preview" });
  assert.ok(html.includes("assortmentTable?"), "operator sees the data gap");
});

test("{{sizeRatio}} is the flat-text form of the same data", async () => {
  const html = await renderLayoutHtml(defWith(["{{sizeRatio}}"]), buildSampleStyleData());
  assert.ok(html.includes("XS: 1, S: 2, M: 3, L: 3, XL: 2, XXL: 1"), html.slice(0, 400));
});

test("{{sizeRatio:size}} narrows to the repetition row's own size", async () => {
  const html = await renderLayoutHtml(
    defWith(["{{size}}=({{sizeRatio:size}})"], "size"),
    buildSampleStyleData(),
  );
  for (const [i, label] of SIZES.entries()) {
    const expected = ["1", "2", "3", "3", "2", "1"][i];
    assert.ok(html.includes(`${label}=(${expected})`), `${label} should print ${expected}`);
  }
});
