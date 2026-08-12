import { test, before } from "node:test";
import assert from "node:assert/strict";
// Type-only — erased at compile time, so it doesn't load the module (which
// would construct the db client) before the DATABASE_URL stub below.
import type { LayoutImageMap } from "./images";

// See assort.test.ts — the render module transitively constructs the db client
// at import time, so a dummy DATABASE_URL lets it load. Nothing here queries:
// the image library is handed to the renderer through opts.layoutImages.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let LayoutDefSchema: typeof import("./schema").LayoutDefSchema;
let renderLayoutHtml: typeof import("./render").renderLayoutHtml;
let buildSampleStyleData: typeof import("../pdf/sample-data").buildSampleStyleData;
let validateTokenRef: typeof import("./token-meta").validateTokenRef;
let tokensInLine: typeof import("./schema").tokensInLine;
let countPlaceholderMarkers: typeof import("../pdf/placeholders").countPlaceholderMarkers;
let documentLines: typeof import("./lines").documentLines;
let slugifyImageName: typeof import("./image-slug").slugifyImageName;
let normalizeImageSlug: typeof import("./image-slug").normalizeImageSlug;
let findLayoutImage: typeof import("./images").findLayoutImage;

before(async () => {
  ({ LayoutDefSchema, tokensInLine } = await import("./schema"));
  ({ renderLayoutHtml } = await import("./render"));
  ({ buildSampleStyleData } = await import("../pdf/sample-data"));
  ({ validateTokenRef } = await import("./token-meta"));
  ({ countPlaceholderMarkers } = await import("../pdf/placeholders"));
  ({ documentLines } = await import("./lines"));
  ({ slugifyImageName, normalizeImageSlug } = await import("./image-slug"));
  ({ findLayoutImage } = await import("./images"));
});

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function library(entries: Array<[string, string | null]>): LayoutImageMap {
  return new Map(
    entries.map(([slug, dataUrl]) => [slug, { slug, name: `Image ${slug}`, dataUrl }]),
  );
}

function defWith(lines: string[]) {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 100,
        heightMm: 60,
        blocks: [
          { id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 6 }, fontPt: 9, lines },
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------
// Parsing + validation — the slug is checked by SHAPE, not against a fixed
// list, because the library is DB-managed (adding artwork must not need a
// deploy, and a layout may be authored before its picture is uploaded).
// ---------------------------------------------------------------------

test("{{image:slug}} and {{image:slug:width}} parse into key/arg/arg2", () => {
  const bare = tokensInLine("{{image:coop-hanger}}")[0];
  assert.deepEqual({ ...bare }, { key: "image", arg: "coop-hanger", arg2: undefined });

  const sized = tokensInLine("{{image:coop-hanger:40}}")[0];
  assert.deepEqual({ ...sized }, { key: "image", arg: "coop-hanger", arg2: "40" });
});

test("any well-formed slug validates — the library is not a fixed list", () => {
  assert.deepEqual(validateTokenRef("image", "coop-hanger"), []);
  assert.deepEqual(validateTokenRef("image", "mark2"), []);
  // A slug nobody has uploaded yet is still VALID: it's a data gap the
  // renderer surfaces, not an authoring error the publish gate should block.
  assert.deepEqual(validateTokenRef("image", "not-uploaded-yet"), []);
});

test("a missing or malformed slug is an authoring error", () => {
  assert.equal(validateTokenRef("image").length, 1);
  assert.equal(validateTokenRef("image", "Coop Hanger").length, 1); // spaces + capitals
  assert.equal(validateTokenRef("image", "coop_hanger").length, 1); // underscore
  assert.equal(validateTokenRef("image", "-leading").length, 1);
});

test("the width argument is a 1–100 percentage", () => {
  assert.deepEqual(validateTokenRef("image", "x", "40"), []);
  assert.deepEqual(validateTokenRef("image", "x", "100"), []);
  assert.equal(validateTokenRef("image", "x", "0").length, 1);
  assert.equal(validateTokenRef("image", "x", "101").length, 1);
  assert.equal(validateTokenRef("image", "x", "abc").length, 1);
  // The barcode's second argument keeps its own mm range — the two kinds of
  // arg2 must not have leaked into each other.
  assert.deepEqual(validateTokenRef("barcode", "ean13", "8"), []);
  assert.equal(validateTokenRef("barcode", "ean13", "100").length, 1);
});

// ---------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------

test("names slugify to typeable tokens", () => {
  assert.equal(slugifyImageName("Coop hanger mark"), "coop-hanger-mark");
  assert.equal(slugifyImageName("  OEKO-TEX® 100  "), "oeko-tex-100");
  assert.equal(normalizeImageSlug("Coop Hanger"), "coophanger");
});

test("lookup is slug-normalized, and an absent row resolves to null", () => {
  const map = library([["coop-hanger", PNG]]);
  assert.equal(findLayoutImage(map, "coop-hanger")?.dataUrl, PNG);
  assert.equal(findLayoutImage(map, "COOP-HANGER")?.dataUrl, PNG);
  assert.equal(findLayoutImage(map, "nope"), null);
});

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------

test("several images render on one output — the point of the library", async () => {
  const style = buildSampleStyleData();
  const html = await renderLayoutHtml(
    defWith(["{{image:coop-logo}}", "{{image:coop-hanger}}"]),
    style,
    { mode: "production", layoutImages: library([["coop-logo", PNG], ["coop-hanger", PNG]]) },
  );
  assert.equal((html.match(/class="ol-img"/g) ?? []).length, 2);
  assert.equal(countPlaceholderMarkers(html), 0);
});

test("a bare token sizes by font height; a width argument sizes by block width", async () => {
  const style = buildSampleStyleData();
  const map = library([["mark", PNG]]);

  const bare = await renderLayoutHtml(defWith(["{{image:mark}}"]), style, {
    mode: "production",
    layoutImages: map,
  });
  assert.match(bare, /<span class="ol-img">/);
  // No inline width on the bare form — the height CSS variable does the
  // sizing. (Checked on the markup, not the document: the stylesheet
  // naturally mentions .ol-img-w whether or not any span uses it.)
  assert.doesNotMatch(bare, /<span class="ol-img ol-img-w"/);

  const sized = await renderLayoutHtml(defWith(["{{image:mark:40}}"]), style, {
    mode: "production",
    layoutImages: map,
  });
  assert.match(sized, /class="ol-img ol-img-w" style="width: 40%"/);
});

test("an unresolvable image prints a placeholder that blocks approval", async () => {
  const style = buildSampleStyleData();

  // Three ways to be unresolvable, one behaviour: no such slug, a row with
  // no artwork, and (via loadLayoutImages' active filter) a disabled row.
  for (const map of [library([]), library([["mark", null]])]) {
    const html = await renderLayoutHtml(defWith(["{{image:mark}}"]), style, {
      mode: "production",
      layoutImages: map,
    });
    assert.match(html, /class="missing"/);
    assert.match(html, /no artwork in Settings/);
    assert.equal(countPlaceholderMarkers(html), 1);
  }
});

test("{{logo:custom}} is untouched by the library", async () => {
  const style = buildSampleStyleData();
  const html = await renderLayoutHtml(defWith(["{{logo:custom}}", "{{image:mark}}"]), style, {
    mode: "production",
    customLogo: PNG,
    layoutImages: library([["mark", PNG]]),
  });
  assert.match(html, /class="ol-logo ol-logo-custom"/);
  assert.match(html, /class="ol-img"/);
  assert.equal(countPlaceholderMarkers(html), 0);
});

test("the review line editor shows an image line as a graphic", () => {
  const style = buildSampleStyleData();
  const lines = documentLines(defWith(["{{image:coop-hanger}}"]), style, undefined);
  assert.equal(lines[0].kind, "graphic");
  assert.equal(lines[0].resolved, "[image: coop-hanger]");
});
