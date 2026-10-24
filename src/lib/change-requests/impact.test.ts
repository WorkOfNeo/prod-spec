import { test, before } from "node:test";
import assert from "node:assert/strict";
// Type-only — erased at compile time, so nothing loads before the stub below.
import type { ImpactReviewStatus, ImpactRow } from "./types";
import type { DocComparison, StyleComparison } from "./impact";
import type { LayoutDef } from "@/lib/output-layouts/schema";

// The pure core of the impact list. impact.ts (and the render module the last
// test drives) construct the db client at import time, so a dummy DATABASE_URL
// lets them load; nothing here queries. The loader and the route are covered
// with mocks in tests/change-request-impact-route.test.ts.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let impact: typeof import("./impact");
let ImpactSummarySchema: typeof import("./types").ImpactSummarySchema;
let ro: typeof import("@/lib/output-layouts/render-output");
let parseLayoutDef: typeof import("@/lib/output-layouts/schema").parseLayoutDef;
let buildSampleStyleData: typeof import("@/lib/pdf/sample-data").buildSampleStyleData;

before(async () => {
  impact = await import("./impact");
  ({ ImpactSummarySchema } = await import("./types"));
  ro = await import("@/lib/output-layouts/render-output");
  ({ parseLayoutDef } = await import("@/lib/output-layouts/schema"));
  ({ buildSampleStyleData } = await import("@/lib/pdf/sample-data"));
});

const doc = (suffix: string | null, html: string) => ({ suffix, html });
const BASE = "layout:bogus-layout";

// ── normaliseHtml ────────────────────────────────────────────────────────────

test("normaliseHtml drops formatting whitespace: indentation, blank lines, CRLF, the ends", () => {
  const a = "<html>\n  <body>\n    <div class=\"ol-line\">A</div>\n  </body>\n</html>\n";
  const b = "  <html>\r\n<body>\r\n\r\n\t<div class=\"ol-line\">A</div>   \n</body>\n\n\n</html>";
  assert.equal(impact.normaliseHtml(a), impact.normaliseHtml(b));
  assert.equal(impact.normaliseHtml(a), '<html>\n<body>\n<div class="ol-line">A</div>\n</body>\n</html>');
});

test("normaliseHtml keeps spaces inside a line: .ol-line is pre-wrap, so they print", () => {
  const one = '<div class="ol-line">12 PCS</div>';
  const two = '<div class="ol-line">12  PCS</div>';
  assert.notEqual(impact.normaliseHtml(one), impact.normaliseHtml(two));
  // A literal no-break space prints too — it is not ASCII whitespace.
  assert.notEqual(impact.normaliseHtml("<b>A </b>"), impact.normaliseHtml("<b>A</b>"));
  assert.equal(impact.normaliseHtml(" x "), " x ");
});

// ── compareDocs ──────────────────────────────────────────────────────────────

test("compareDocs: same document (modulo formatting) is unchanged, different text is changed", () => {
  assert.deepEqual(impact.compareDocs([doc(null, "<p>A</p>\n")], [doc(null, "  <p>A</p>")]), [
    { suffix: null, changed: false },
  ]);
  assert.deepEqual(impact.compareDocs([doc(null, "<p>A</p>")], [doc(null, "<p>B</p>")]), [
    { suffix: null, changed: true },
  ]);
});

test("compareDocs pairs split documents by suffix, whatever order each side lists them in", () => {
  const current = [doc("s", "<p>S</p>"), doc("m", "<p>M</p>"), doc("l", "<p>L</p>")];
  const proposed = [doc("l", "<p>L</p>"), doc("s", "<p>S!</p>"), doc("m", "<p>M</p>")];
  assert.deepEqual(impact.compareDocs(current, proposed), [
    { suffix: "s", changed: true },
    { suffix: "m", changed: false },
    { suffix: "l", changed: false },
  ]);
});

test("compareDocs: a document on one side only counts as changed; proposal-only ones come last", () => {
  const current = [doc("s", "<p>S</p>"), doc("m", "<p>M</p>")];
  const proposed = [doc("xl", "<p>XL</p>"), doc("m", "<p>M</p>")];
  assert.deepEqual(impact.compareDocs(current, proposed), [
    { suffix: "s", changed: true },
    { suffix: "m", changed: false },
    { suffix: "xl", changed: true },
  ]);
  // One document becoming a split set: the single doc goes, every PDF is new.
  assert.deepEqual(impact.compareDocs([doc(null, "<p>A</p>")], [doc("s", "<p>A</p>"), doc("m", "<p>A</p>")]), [
    { suffix: null, changed: true },
    { suffix: "s", changed: true },
    { suffix: "m", changed: true },
  ]);
  assert.deepEqual(impact.compareDocs([], []), []);
});

test("compareDocs keeps the first copy of a repeated suffix", () => {
  const out = impact.compareDocs([doc("s", "<p>S</p>"), doc("s", "<p>other</p>")], [doc("s", "<p>S</p>")]);
  assert.deepEqual(out, [{ suffix: "s", changed: false }]);
});

// ── docKey / mapReviewStatus ─────────────────────────────────────────────────

test("docKey is the runner's asset key: the base, or base#suffix", () => {
  assert.equal(impact.docKey(BASE, null), BASE);
  assert.equal(impact.docKey(BASE, "m-blue"), `${BASE}#m-blue`);
});

test("mapReviewStatus passes the three asset statuses through; nothing generated is NONE", () => {
  assert.equal(impact.mapReviewStatus("PENDING_REVIEW"), "PENDING_REVIEW");
  assert.equal(impact.mapReviewStatus("APPROVED"), "APPROVED");
  assert.equal(impact.mapReviewStatus("REJECTED"), "REJECTED");
  assert.equal(impact.mapReviewStatus(null), "NONE");
  assert.equal(impact.mapReviewStatus(undefined), "NONE");
});

// ── buildImpactRows ──────────────────────────────────────────────────────────

function comparison(styleId: string, docs: DocComparison[], extra: Partial<StyleComparison> = {}): StyleComparison {
  return { styleId, styleLabel: `Style ${styleId}`, poNumber: "PO-0000", baseKey: BASE, docs, ...extra };
}

test("buildImpactRows joins review status per document, delivery per base output, in-flight per style", () => {
  const rows = impact.buildImpactRows(
    [
      comparison("style-a", [
        { suffix: "s", changed: true },
        { suffix: "m", changed: false },
      ]),
      comparison("style-b", [{ suffix: null, changed: true }], { poNumber: null }),
      comparison("style-c", [{ suffix: null, changed: false }]),
    ],
    {
      reviewByStyle: new Map<string, Map<string, ImpactReviewStatus>>([
        [
          "style-a",
          new Map([
            [`${BASE}#s`, "APPROVED"],
            [`${BASE}#m`, "PENDING_REVIEW"],
          ]),
        ],
        // A suffixed asset never answers for the base key.
        ["style-b", new Map([[`${BASE}#s`, "REJECTED"]])],
      ]),
      deliveryByStyle: new Map([["style-a", { uploaded: true, emailed: false }]]),
      inFlight: new Set(["style-b"]),
    },
  );
  assert.deepEqual(rows, [
    {
      styleId: "style-a",
      styleLabel: "Style style-a",
      poNumber: "PO-0000",
      variantKey: `${BASE}#s`,
      changed: true,
      reviewStatus: "APPROVED",
      uploaded: true,
      emailed: false,
      inFlight: false,
    },
    {
      styleId: "style-a",
      styleLabel: "Style style-a",
      poNumber: "PO-0000",
      variantKey: `${BASE}#m`,
      changed: false,
      reviewStatus: "PENDING_REVIEW",
      uploaded: true,
      emailed: false,
      inFlight: false,
    },
    {
      styleId: "style-b",
      styleLabel: "Style style-b",
      poNumber: null,
      variantKey: BASE,
      changed: true,
      reviewStatus: "NONE",
      uploaded: false,
      emailed: false,
      inFlight: true,
    },
    {
      styleId: "style-c",
      styleLabel: "Style style-c",
      poNumber: "PO-0000",
      variantKey: BASE,
      changed: false,
      reviewStatus: "NONE",
      uploaded: false,
      emailed: false,
      inFlight: false,
    },
  ]);
});

// ── summarise ────────────────────────────────────────────────────────────────

function row(extra: Partial<ImpactRow>): ImpactRow {
  return {
    styleId: "style-a",
    styleLabel: "Style A",
    poNumber: "PO-0000",
    variantKey: BASE,
    changed: true,
    reviewStatus: "PENDING_REVIEW",
    uploaded: false,
    emailed: false,
    inFlight: false,
    ...extra,
  };
}

test("summarise counts changed docs per status, approved and delivered ones, and validates", () => {
  const rows = [
    row({ styleId: "style-a", variantKey: `${BASE}#s`, reviewStatus: "APPROVED", uploaded: true, emailed: true }),
    row({ styleId: "style-a", variantKey: `${BASE}#m`, reviewStatus: "APPROVED" }),
    row({ styleId: "style-b", reviewStatus: "PENDING_REVIEW", emailed: true }),
    row({ styleId: "style-c", reviewStatus: "NONE" }),
    // Unchanged docs count as docs, never as approved/delivered changes.
    row({ styleId: "style-d", changed: false, reviewStatus: "APPROVED", uploaded: true }),
  ];
  const counts = impact.summarise(rows);
  assert.deepEqual(counts, {
    styles: 4,
    docs: 5,
    changed: 4,
    unchanged: 1,
    changedByStatus: { PENDING_REVIEW: 1, APPROVED: 2, REJECTED: 0, NONE: 1 },
    approvedChanged: 2,
    deliveredChanged: 2,
  });
  const summary = { rows, counts, errors: [{ styleId: "style-x", message: "Style not found" }], durationMs: 12 };
  assert.deepEqual(ImpactSummarySchema.parse(summary), summary);
});

test("summarise of nothing still carries every review status, and takes the compared style count", () => {
  const counts = impact.summarise([], 3);
  assert.deepEqual(counts, {
    styles: 3,
    docs: 0,
    changed: 0,
    unchanged: 0,
    changedByStatus: { PENDING_REVIEW: 0, APPROVED: 0, REJECTED: 0, NONE: 0 },
    approvedChanged: 0,
    deliveredChanged: 0,
  });
  assert.deepEqual(ImpactSummarySchema.parse({ rows: [], counts }), { rows: [], counts });
});

// ── With the real renderer (synthetic layout + sample style) ────────────────
// The comparison runs on what renderStyleOutput emits; these renders go through
// the same variant-for-definition step with stored line rewrites left out (no
// database), and show the normaliser neither invents nor hides a change.

const ROW = {
  id: "bogus-layout",
  name: "Test sticker",
  docType: "STICKER",
  version: 3,
  isInfoArea: false,
  customLogo: null,
};

function def(lines: string[]): LayoutDef {
  return parseLayoutDef({
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 50,
        heightMm: 30,
        blocks: [{ rect: { col: 0, row: 0, colSpan: 12, rowSpan: 6 }, fontPt: 9, lines }],
      },
    ],
    settings: { repeatBy: "size", splitBy: "ean" },
  });
}

async function renderDocs(d: LayoutDef) {
  const variant = ro.variantForDefinition(ROW, d);
  assert.ok(variant, "fixture layout must build a variant");
  const target = ro.assembleOutputTarget({
    styleId: "bogus-style",
    baseKey: variant.key,
    variant,
    output: { variantKey: variant.key, widthMm: 40, heightMm: 30, enabled: true },
    styleData: buildSampleStyleData(),
    fieldValues: new Map(),
    infoAreaSizes: new Map(),
    def: d,
  });
  return ro.renderOutputTarget(target, { documents: "files", lines: "none" });
}

test("real renders: same def → no change; an untaken branch → no change; a visible edit → every doc", async () => {
  const lines = ["{{styleNumber}}", "{{size}} · {{customerName}}"];
  const current = await renderDocs(def(lines));
  assert.ok(current.length > 1, "the sample style splits into one document per EAN");
  assert.ok(current.every((d) => d.suffix !== null));

  const same = impact.compareDocs(current, await renderDocs(def([...lines])));
  assert.equal(same.length, current.length);
  assert.ok(same.every((c) => !c.changed), "re-rendering the same definition changes nothing");

  const untaken = impact.compareDocs(
    await renderDocs(def([...lines, '{{if customerName == "Nobody"}}OLD{{endif}}'])),
    await renderDocs(def([...lines, '{{if customerName == "Nobody"}}NEW{{endif}}'])),
  );
  assert.ok(untaken.every((c) => !c.changed), "an edit behind a condition no document meets prints nothing new");
  const taken = impact.compareDocs(
    await renderDocs(def([...lines, '{{if customerName != "Nobody"}}OLD{{endif}}'])),
    await renderDocs(def([...lines, '{{if customerName != "Nobody"}}NEW{{endif}}'])),
  );
  assert.ok(taken.every((c) => c.changed), "the same edit behind a condition every document meets shows");

  const spaced = await renderDocs(def(["{{styleNumber}}", "{{size}}  ·  {{customerName}}"]));
  const edited = impact.compareDocs(current, spaced);
  assert.equal(edited.length, current.length);
  assert.ok(edited.every((c) => c.changed), "a spacing edit shows on every document");
});
