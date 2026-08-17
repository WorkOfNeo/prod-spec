import { test, before } from "node:test";
import assert from "node:assert/strict";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load (nothing here queries).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let insetCornerRadiusMm: typeof import("./schema").insetCornerRadiusMm;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;

before(async () => {
  ({ LayoutDefSchema, insetCornerRadiusMm } = await import("./schema"));
  ({ renderLayoutHtml } = await import("./render"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
});

function defWith(page: Record<string, unknown>) {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 100,
        heightMm: 60,
        ...page,
        blocks: [
          {
            id: "b1",
            rect: { col: 0, row: 0, colSpan: 6, rowSpan: 3 },
            fontPt: 9,
            lines: ["{{styleNumber}}"],
          },
        ],
      },
    ],
  });
}

// The `.ol-page-0` rule — where the page's own size and radius live.
function pageRule(html: string): string {
  const m = /\.ol-page-0 \{([^}]*)\}/.exec(html);
  assert.ok(m, "expected the page rule");
  return m[1];
}

function frame(html: string): string | null {
  const m = /<div class="ol-page-border" style="([^"]*)"/.exec(html);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------
// Rounded corners — the die's corner radius. The PAGE rounds (content is
// clipped to the shape); the @page box stays rectangular, because the
// sheet it prints on is.
// ---------------------------------------------------------------------

test("no radius ⇒ no border-radius anywhere (existing layouts unchanged)", async () => {
  const html = await renderLayoutHtml(defWith({}), buildSampleStyleData());
  assert.ok(!pageRule(html).includes("border-radius"), pageRule(html));
});

test("a radius rounds the page, leaving the paper size rectangular", async () => {
  const html = await renderLayoutHtml(defWith({ cornerRadiusMm: 4 }), buildSampleStyleData());
  assert.ok(pageRule(html).includes("border-radius: 4mm"), pageRule(html));
  // The @page box is the SHEET — it must not gain a radius.
  const atPage = /@page olp0 \{([^}]*)\}/.exec(html);
  assert.ok(atPage, "expected the @page rule");
  assert.ok(!atPage[1].includes("border-radius"), atPage[1]);
  // Content clipping is what makes the die shape real, and .ol-page has
  // carried overflow:hidden since long before this.
  assert.ok(/\.ol-page \{[^}]*overflow: hidden/.test(html), "the page must still clip its content");
});

test("radius 0 is square — the same output as leaving it unset", async () => {
  const zero = await renderLayoutHtml(defWith({ cornerRadiusMm: 0 }), buildSampleStyleData());
  const unset = await renderLayoutHtml(defWith({}), buildSampleStyleData());
  assert.equal(pageRule(zero), pageRule(unset));
});

test("the page border curves with the die, tightened by its own inset", async () => {
  const html = await renderLayoutHtml(
    defWith({
      cornerRadiusMm: 5,
      pageBorder: { widthMm: 0.3, color: "#000000", insetMm: 2 },
    }),
    buildSampleStyleData(),
  );
  const f = frame(html);
  assert.ok(f, "expected the frame");
  assert.ok(f.includes("border-radius: 3mm"), f); // 5 − 2, concentric
});

test("a frame inset past the radius is square, not negative", async () => {
  const html = await renderLayoutHtml(
    defWith({
      cornerRadiusMm: 3,
      pageBorder: { widthMm: 0.3, color: "#000000", insetMm: 8 },
    }),
    buildSampleStyleData(),
  );
  const f = frame(html);
  assert.ok(f, "expected the frame");
  assert.ok(!f.includes("border-radius"), f);
});

test("a frame on a SQUARE page never gains a radius", async () => {
  const html = await renderLayoutHtml(
    defWith({ pageBorder: { widthMm: 0.3, color: "#000000", insetMm: 2 } }),
    buildSampleStyleData(),
  );
  const f = frame(html);
  assert.ok(f, "expected the frame");
  assert.ok(!f.includes("border-radius"), f);
});

// ---------------------------------------------------------------------
// The cut line — the die drawn in red so it survives into print. The sheet
// Chromium prints is a rectangle, so without a stroke a rounded page with no
// full-bleed ink comes out square and the supplier has nothing to cut to.
// ---------------------------------------------------------------------

function cut(html: string): string | null {
  const m = /<div class="ol-guide ol-cut" style="([^"]*)"/.exec(html);
  return m ? m[1] : null;
}

test("a rounded page draws the cut line at the die's own radius", async () => {
  const html = await renderLayoutHtml(defWith({ cornerRadiusMm: 3 }), buildSampleStyleData());
  const c = cut(html);
  assert.ok(c, "expected the cut line");
  assert.ok(c.includes("border-radius: 3mm"), c);
  // Red and dashed — a guide, not artwork — and flush to the page edge.
  assert.ok(/\.ol-cut \{[^}]*inset: 0[^}]*dashed #ff0000/.test(html), "expected the red dashed rule");
});

test("a square page has no cut line — there the die IS the paper edge", async () => {
  for (const page of [{}, { cornerRadiusMm: 0 }]) {
    const html = await renderLayoutHtml(defWith(page), buildSampleStyleData());
    assert.equal(cut(html), null);
  }
});

test("the cut line can be turned off for artwork that already shows the curve", async () => {
  const html = await renderLayoutHtml(
    defWith({ cornerRadiusMm: 3, cutLine: false }),
    buildSampleStyleData(),
  );
  assert.equal(cut(html), null);
  // …and the die itself is untouched: the page still rounds and still clips.
  assert.ok(pageRule(html).includes("border-radius: 3mm"), pageRule(html));
});

test("a page authored before this gets the cut line by default", () => {
  // The point of default(true): the two live rounded layouts carry no such
  // field, and they are exactly the ones that need the curve to print.
  const parsed = defWith({ cornerRadiusMm: 3 });
  assert.equal(parsed.pages[0].cutLine, true);
});

test("insetCornerRadiusMm is the shared concentric arithmetic", () => {
  assert.equal(insetCornerRadiusMm(5, 2), 3);
  assert.equal(insetCornerRadiusMm(5, 0), 5);
  assert.equal(insetCornerRadiusMm(3, 8), 0); // floors, never negative
  assert.equal(insetCornerRadiusMm(undefined, 2), 0);
});

test("schema rejects a negative or absurd radius", () => {
  assert.throws(() => defWith({ cornerRadiusMm: -1 }));
  assert.throws(() => defWith({ cornerRadiusMm: 80 }));
  assert.doesNotThrow(() => defWith({ cornerRadiusMm: 2.5 }));
});
