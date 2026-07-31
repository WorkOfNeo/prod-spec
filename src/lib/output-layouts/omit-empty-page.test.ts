import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load. Nothing here queries:
// {{cert:…}} only loads the certificate library when the style DECLARES the
// cert, and every style below declares none (which is the case under test).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ LayoutDefSchema } = await import("./schema"));
  ({ renderLayoutHtml } = await import("./render"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

// ---------------------------------------------------------------------
// Conditional pages — a page marked `omitWhenEmpty` leaves the printed
// document when nothing on it resolves for the style. The case it was
// built for: a 3-page care label whose last page is nothing but the
// OEKO-TEX mark, printed for a style that doesn't carry OEKO-TEX.
// ---------------------------------------------------------------------

type PageSpec = { lines: string[]; omitWhenEmpty?: boolean; widthMm?: number; heightMm?: number };

function defWith(pages: PageSpec[], repeatBy?: "size" | "ean") {
  return LayoutDefSchema.parse({
    ...(repeatBy ? { settings: { repeatBy } } : {}),
    pages: pages.map((p, i) => ({
      id: `p${i + 1}`,
      title: `Page ${i + 1}`,
      widthMm: p.widthMm ?? 35,
      heightMm: p.heightMm ?? 45,
      ...(p.omitWhenEmpty ? { omitWhenEmpty: true } : {}),
      blocks: [{ id: `b${i + 1}`, rect: { col: 0, row: 0, colSpan: 6, rowSpan: 6 }, fontPt: 9, lines: p.lines }],
    })),
  });
}

// The classic set: front, care text, then a page carrying only the mark.
const CERT_LAST = [
  { lines: ["{{styleNumber}}"] },
  { lines: ["{{composition}}"] },
  { lines: ["{{cert:oekotex}}"], omitWhenEmpty: true },
];

function pageCount(html: string): number {
  return [...html.matchAll(/class="ol-page ol-page-\d+"/g)].length;
}

// A style that declares no certificates at all — the OEKO-TEX page has
// nothing to print for it.
function styleWithoutCerts() {
  return { ...buildSampleStyleData(), certificates: [] };
}

test("last page is only OEKO-TEX and the style doesn't have it ⇒ that page isn't printed", async () => {
  const html = await renderLayoutHtml(defWith(CERT_LAST), styleWithoutCerts(), { mode: "production" });
  assert.equal(pageCount(html), 2, "the cert-only page must drop out of the document");
  assert.ok(html.includes("STY-10427"), "the pages that do resolve still print");
});

test("without the toggle the empty cert page still prints (existing layouts unchanged)", async () => {
  const asAuthored = CERT_LAST.map((p) => ({ ...p, omitWhenEmpty: false }));
  const html = await renderLayoutHtml(defWith(asAuthored), styleWithoutCerts(), { mode: "production" });
  assert.equal(pageCount(html), 3, "opting out must keep the blank page exactly as before");
});

test("the builder preview keeps every page — it has to stay editable", async () => {
  const html = await renderLayoutHtml(defWith(CERT_LAST), styleWithoutCerts(), { mode: "preview" });
  assert.equal(pageCount(html), 3);
  assert.ok(html.includes("not on style"), "preview still explains why the mark is gated");
});

test("a page that resolves is kept even with the toggle on", async () => {
  const html = await renderLayoutHtml(
    defWith([{ lines: ["{{styleNumber}}"] }, { lines: ["{{campaignWeek}}"], omitWhenEmpty: true }]),
    styleWithoutCerts(),
    { mode: "production" },
  );
  assert.equal(pageCount(html), 2);
});

test("literal text keeps a page — only pages that print NOTHING drop", async () => {
  const html = await renderLayoutHtml(
    defWith([{ lines: ["{{styleNumber}}"] }, { lines: ["Certified", "{{cert:oekotex}}"], omitWhenEmpty: true }]),
    styleWithoutCerts(),
    { mode: "production" },
  );
  assert.equal(pageCount(html), 2, "a page with its own wording is not empty");
});

test("borders, page frames and guides are chrome, not content", async () => {
  const def = LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "Front",
        widthMm: 35,
        heightMm: 45,
        blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 6, rowSpan: 6 }, fontPt: 9, lines: ["{{styleNumber}}"] }],
      },
      {
        id: "p2",
        title: "Cert",
        widthMm: 35,
        heightMm: 45,
        omitWhenEmpty: true,
        foldLine: "horizontal",
        sewingLines: [{ edge: "top", offsetMm: 5 }],
        pageBorder: { widthMm: 0.3, color: "#000000", insetMm: 1 },
        blocks: [
          {
            id: "b2",
            rect: { col: 0, row: 0, colSpan: 6, rowSpan: 6 },
            fontPt: 9,
            border: { widthMm: 0.3, color: "#000000", pad: { topMm: 1, rightMm: 1, bottomMm: 1, leftMm: 1 } },
            lines: ["{{cert:oekotex}}"],
          },
        ],
      },
    ],
  });
  const html = await renderLayoutHtml(def, styleWithoutCerts(), { mode: "production" });
  assert.equal(pageCount(html), 1, "an empty framed box on a guide-only page is still an empty page");
  assert.ok(!html.includes(`class="ol-page-border"`), "the dropped page's frame goes with it");
});

test("every page empty ⇒ nothing is dropped (a PDF can't have zero pages)", async () => {
  const html = await renderLayoutHtml(
    defWith([
      { lines: ["{{cert:fsc}}"], omitWhenEmpty: true },
      { lines: ["{{cert:oekotex}}"], omitWhenEmpty: true },
    ]),
    styleWithoutCerts(),
    { mode: "production" },
  );
  assert.equal(pageCount(html), 2, "dropping everything would print one blank sheet anyway");
});

test("the decision is per repetition row, not per layout", async () => {
  // Per-size repeat where only the first size carries an EAN: the EAN page
  // prints for that row and drops for the other.
  const style = {
    ...styleWithoutCerts(),
    sizes: [
      { label: "S", ean13: "5700123456787" },
      { label: "M", ean13: "" },
    ],
    eanVariants: [],
  };
  const html = await renderLayoutHtml(
    defWith([{ lines: ["{{size}}"] }, { lines: ["{{ean13}}"], omitWhenEmpty: true }], "size"),
    style,
    { mode: "production" },
  );
  // S → size page + EAN page, M → size page only.
  assert.equal(pageCount(html), 3);
  assert.ok(html.includes("5700123456787"), "the row that has an EAN still prints it");
});

test("dropping a page renumbers the named @page rules and keeps their sizes", async () => {
  const html = await renderLayoutHtml(
    defWith([
      { lines: ["{{cert:oekotex}}"], omitWhenEmpty: true, widthMm: 35, heightMm: 45 },
      { lines: ["{{styleNumber}}"], widthMm: 100, heightMm: 75 },
    ]),
    styleWithoutCerts(),
    { mode: "production" },
  );
  assert.equal(pageCount(html), 1);
  assert.ok(html.includes("@page olp0 { size: 100mm 75mm"), "the surviving page becomes page 0");
  assert.ok(!html.includes("olp1"), "no rule is left pointing at a page that isn't there");
  // The document's default @page follows the first PRINTED page, so a
  // dropped leading page can't leave the PDF defaulting to a size nothing
  // uses (Chromium falls back to it for anything unnamed).
  assert.ok(/@page \{ size: 100mm 75mm/.test(html), "default page size follows the first printed page");
});
