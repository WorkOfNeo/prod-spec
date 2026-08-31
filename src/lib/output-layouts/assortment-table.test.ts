import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load (nothing here queries).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;
let validateTokenRef: typeof import("./token-meta").validateTokenRef;

before(async () => {
  ({ LayoutDefSchema } = await import("./schema"));
  ({ renderLayoutHtml } = await import("./render"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
  ({ validateTokenRef } = await import("./token-meta"));
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

// -----------------------------------------------------
// {{assortmentTable:total}} — the summed row
// -----------------------------------------------------

// The total cell, or "" when the table carries none.
function totalCell(html: string): string {
  return /<td class="ol-assort-total">([\s\S]*?)<\/td>/.exec(html)?.[1] ?? "";
}

test("the bare table carries no total column", async () => {
  const html = await renderLayoutHtml(defWith(["{{assortmentTable}}"]), buildSampleStyleData());
  assert.equal(totalCell(html), "", "no total unless it was asked for");
  // The stylesheet always carries the .ol-assort-total rule — it's the
  // MARKUP that must be absent (same reasoning as the no-ratio test).
  assert.ok(
    !html.includes(`<th class="ol-assort-total">`),
    "and no empty corner header either",
  );
});

test("{{assortmentTable:total}} adds the summed row, bottom-right on the qty row", async () => {
  const html = await renderLayoutHtml(
    defWith(["{{assortmentTable:total}}"]),
    buildSampleStyleData(),
  );
  // The sample ratio 1+2+3+3+2+1 = 12.
  assert.equal(totalCell(html), "12 PCS");
  // The size row keeps its own columns and gains an empty corner cell, so
  // the total sits under nothing and beside the last size's qty.
  const { head, qty } = cells(html);
  assert.deepEqual(head, SIZES, "the size columns are untouched");
  assert.deepEqual(qty, ["1", "2", "3", "3", "2", "1"], "the qty columns are untouched");
  assert.ok(html.includes(`<th class="ol-assort-total"></th>`), "empty corner above the total");
  // Bottom-right: the total is the LAST cell of the qty row.
  assert.ok(
    /<td class="ol-assort-total">12 PCS<\/td><\/tr><\/table>/.test(html),
    "total closes the qty row",
  );
});

test("the total sums what the table PRINTS — reduced ratio, not the buyer's totals", async () => {
  const style = {
    ...buildSampleStyleData(),
    sizeRatioRaw: "XS-1000, S-2000, M-3000, L-3000, XL-2000, XXL-1000",
  };
  const html = await renderLayoutHtml(defWith(["{{assortmentTable:total}}"]), style);
  assert.deepEqual(cells(html).qty, ["1", "2", "3", "3", "2", "1"]);
  assert.equal(totalCell(html), "12 PCS", "12, not the 12,000 the buyer typed");
});

test("sizes with no ratio contribute nothing to the total", async () => {
  const style = { ...buildSampleStyleData(), sizeRatioRaw: "XS-1, S-2, M-3" };
  const html = await renderLayoutHtml(defWith(["{{assortmentTable:total}}"]), style);
  assert.deepEqual(cells(html).qty, ["1", "2", "3", "", "", ""]);
  assert.equal(totalCell(html), "6 PCS", "the empty cells add nothing");
});

test("{{assortmentTotal}} prints the same number on its own", async () => {
  const html = await renderLayoutHtml(
    defWith(["Total {{assortmentTotal}} PCS"]),
    buildSampleStyleData(),
  );
  assert.ok(html.includes("Total 12 PCS"), html.slice(0, 400));
});

test("{{assortmentTotal}} is empty on a style with no readable ratio", async () => {
  const style = { ...buildSampleStyleData(), sizeRatioRaw: undefined };
  // Literals either side so the line survives; the token itself must
  // resolve to nothing rather than a misleading "0".
  const prod = await renderLayoutHtml(defWith(["[{{assortmentTotal}}]"]), style, {
    mode: "production",
  });
  assert.ok(prod.includes("[]"), "never a stray 0");
  const preview = await renderLayoutHtml(defWith(["{{assortmentTotal}}"]), style, {
    mode: "preview",
  });
  assert.ok(preview.includes("assortmentTotal?"), "operator sees the data gap");
});

test("publish validation accepts :total and rejects anything else", () => {
  assert.deepEqual(validateTokenRef("assortmentTable"), []);
  assert.deepEqual(validateTokenRef("assortmentTable", "total"), []);
  assert.deepEqual(validateTokenRef("assortmentTotal"), []);
  const errs = validateTokenRef("assortmentTable", "sum");
  assert.equal(errs.length, 1);
  assert.match(errs[0], /only table option/);
  // The standalone total takes no argument at all.
  assert.equal(validateTokenRef("assortmentTotal", "total").length, 1);
});

test("the total rides every repetition, like the table itself", async () => {
  const html = await renderLayoutHtml(
    defWith(["{{size}}", "{{assortmentTable:total}}"], "size"),
    buildSampleStyleData(),
  );
  const totals = [...html.matchAll(/<td class="ol-assort-total">([\s\S]*?)<\/td>/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(totals, SIZES.map(() => "12 PCS"), "the pack total, not the row's");
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

test("cells never wrap — the table shrinks to fit instead", async () => {
  const html = await renderLayoutHtml(defWith(["{{assortmentTable}}"]), buildSampleStyleData());
  assert.ok(
    /\.ol-assort th, \.ol-assort td \{[\s\S]*?white-space: nowrap;/.test(html),
    "size labels like 86/92 stay on one line",
  );
  assert.ok(
    !/\.ol-assort th, \.ol-assort td \{[\s\S]*?word-break: break-word/.test(html),
    "no mid-token breaking in the cells",
  );
  assert.ok(
    html.includes("window.__olFitWidth"),
    "the fit script ships even though no block opted in — the table pass needs it",
  );
  assert.ok(html.includes(".ol-assort"), "the fit pass targets the table");
});

test("no table on the page ⇒ the fit script is still gated off", async () => {
  const html = await renderLayoutHtml(defWith(["{{styleNumber}}"]), buildSampleStyleData());
  assert.ok(!html.includes("window.__olFitWidth"), "plain layouts stay script-free");
});
