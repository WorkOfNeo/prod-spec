// GET /api/admin/change-requests/revisions/[revisionId]/proof — the gate
// (flag → session → ADMIN → params) and renderProof's orchestration behind it:
// "before" is what prints today, "after" the draft, both through the real
// renderStyleOutput pipeline; typed not-found answers; the picture cache.
//
// Drives the REAL route handler and the REAL render pipeline with a mocked
// session, a stub `db`, a mocked style render context and a stand-in for the
// Chromium step (renderHtmlPng records the HTML it was given) — nothing
// touches a database or a browser. The real rasterisation is covered in
// src/lib/change-requests/proofs.test.ts (skipped without a browser).
// Fixtures are synthetic.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { ProdSpecOutput } from "@/lib/prod-spec/config";
import type { StyleRenderContext } from "@/lib/styles/render-context";

// ── Session ─────────────────────────────────────────────────────────────────
let sessionState: { session: unknown; role: string | null } = { session: null, role: null };
const asAdmin = () => {
  sessionState = { session: { user: { id: "admin-1", email: "admin@example.com" } }, role: "ADMIN" };
};
const asReviewer = () => {
  sessionState = { session: { user: { id: "rev-1", email: "reviewer@example.com" } }, role: "REVIEWER" };
};
const asAnon = () => {
  sessionState = { session: null, role: null };
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const STYLE_ID = "bogus-style";
const OTHER_STYLE_ID = "bogus-style-without-layout";
// Prints the layout with the output's customerName pinned.
const PINNED_STYLE_ID = "bogus-style-pinned";
// Its Trims column states a solid polybag of 5 pieces ({{polybagQty}} = "5").
const POLYBAG_STYLE_ID = "bogus-style-polybag";
const POLYBAG_LINE = '{{if polybagQty != ""}}{{polybagQty}} PCS{{endif}}';
const LAYOUT_ID = "bogus-layout";
const KEY = `layout:${LAYOUT_ID}`;

function rawDef(text: string, settings?: Record<string, unknown>) {
  return {
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 50,
        heightMm: 30,
        blocks: [{ rect: { col: 0, row: 0, colSpan: 12, rowSpan: 6 }, fontPt: 9, lines: [text, "{{styleNumber}}"] }],
      },
    ],
    ...(settings ? { settings } : {}),
  };
}

// The live layout plus the design's reference change: a new polybag block.
function polybagDef() {
  const def = rawDef("LIVE TEXT");
  const blocks: unknown[] = def.pages[0].blocks;
  blocks.push({ rect: { col: 0, row: 6, colSpan: 12, rowSpan: 2 }, fontPt: 8, lines: [POLYBAG_LINE] });
  return def;
}

type LayoutRow = {
  id: string;
  name: string;
  docType: string;
  definition: unknown;
  version: number;
  isInfoArea: boolean;
  customLogo: string | null;
  status: string;
};
type RevisionRow = {
  id: string;
  layoutId: string;
  number: number;
  status: string;
  definition: unknown;
  baseDefinition: unknown;
  baseVersion: number;
};

let layout: LayoutRow;
let revisions: RevisionRow[];

function resetFixtures() {
  layout = {
    id: LAYOUT_ID,
    name: "Test sticker",
    docType: "STICKER",
    definition: rawDef("LIVE TEXT"),
    version: 3,
    isInfoArea: false,
    customLogo: null,
    status: "PUBLISHED",
  };
  revisions = [
    {
      id: "rev-draft",
      layoutId: LAYOUT_ID,
      number: 1,
      status: "DRAFT",
      definition: rawDef("DRAFT TEXT"),
      baseDefinition: rawDef("LIVE TEXT"),
      baseVersion: 3,
    },
    {
      id: "rev-published",
      layoutId: LAYOUT_ID,
      number: 2,
      status: "PUBLISHED",
      definition: rawDef("LIVE TEXT"),
      baseDefinition: rawDef("OLD TEXT"),
      baseVersion: 2,
    },
    {
      id: "rev-polybag",
      layoutId: LAYOUT_ID,
      number: 4,
      status: "DRAFT",
      definition: polybagDef(),
      baseDefinition: rawDef("LIVE TEXT"),
      baseVersion: 3,
    },
    {
      id: "rev-split",
      layoutId: LAYOUT_ID,
      number: 3,
      status: "DRAFT",
      definition: rawDef("SPLIT {{size}}", { repeatBy: "size", splitBy: "ean" }),
      baseDefinition: rawDef("LIVE TEXT"),
      baseVersion: 3,
    },
  ];
}

let buildSampleStyleData: typeof import("@/lib/pdf/sample-data").buildSampleStyleData;

function makeCtx(styleId: string, outputs: ProdSpecOutput[], trimsRaw?: string): StyleRenderContext {
  return {
    styleId,
    poSeq: null,
    styleData: { ...buildSampleStyleData(), ...(trimsRaw !== undefined ? { trimsRaw } : {}) },
    prodSpec: { id: "bogus-spec", name: "Spec" },
    outputs,
    readiness: [],
  };
}

const dbMock = {
  outputLayoutRevision: {
    findUnique: async (args: { where: { id: string } }) => revisions.find((r) => r.id === args.where.id) ?? null,
  },
  outputLayout: {
    findUnique: async (args: { where: { id: string } }) => (args.where.id === layout.id ? layout : null),
    findMany: async () => [layout],
  },
  styleOutputFieldValue: { findFirst: async () => ({ id: "probe" }), findMany: async () => [] },
  styleOutputLineValue: { findFirst: async () => ({ id: "probe" }), findMany: async () => [] },
  infoAreaSize: { findMany: async () => [] },
  // stylesUsingLayout (the control's same-ProdSpec preference).
  prodSpec: {
    findMany: async () => [
      { id: "bogus-spec", name: "Spec", outputs: [{ variantKey: KEY, widthMm: 50, heightMm: 30, enabled: true }] },
    ],
  },
  style: {
    findMany: async () =>
      [STYLE_ID, PINNED_STYLE_ID, POLYBAG_STYLE_ID].map((id) => ({
        id,
        name: id,
        poNumber: "PO-0000",
        prodSpecId: "bogus-spec",
      })),
  },
};

// The Chromium step, recorded: each call's HTML and page box.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngCalls: { html: string; widthMm: number; heightMm: number; scale?: number }[] = [];
const renderHtmlPng = mock.fn(async (opts: { html: string; widthMm: number; heightMm: number; scale?: number }) => {
  pngCalls.push(opts);
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(`#${pngCalls.length}`)]);
});

type RouteModule = typeof import("@/app/api/admin/change-requests/revisions/[revisionId]/proof/route");
let GET: RouteModule["GET"];
let proofs: typeof import("@/lib/change-requests/proofs");

before(async () => {
  mock.module("@/lib/auth-server", {
    namedExports: {
      getServerSession: async () => sessionState.session,
      getSessionWithRole: async () => sessionState,
    },
  });
  mock.module("@/lib/db", { namedExports: { db: dbMock } });
  mock.module("@/lib/styles/render-context", {
    namedExports: {
      loadStyleRenderContext: async (id: string) => {
        if (id === STYLE_ID) return makeCtx(id, [{ variantKey: KEY, widthMm: 50, heightMm: 30, enabled: true }]);
        if (id === OTHER_STYLE_ID) return makeCtx(id, [{ variantKey: "care-label-01", widthMm: 35, heightMm: 40, enabled: true }]);
        if (id === PINNED_STYLE_ID) {
          return makeCtx(id, [
            { variantKey: KEY, widthMm: 50, heightMm: 30, enabled: true, fieldOverrides: { customerName: "Pinned Co" } },
          ]);
        }
        if (id === POLYBAG_STYLE_ID) {
          return makeCtx(id, [{ variantKey: KEY, widthMm: 50, heightMm: 30, enabled: true }], "Solid polybag- 5 Pcs / Polybag");
        }
        return null;
      },
    },
  });
  mock.module("@/lib/pdf/renderer", {
    namedExports: {
      renderHtmlPng,
      renderPdf: async () => Buffer.from(""),
      closeBrowser: async () => {},
    },
  });

  ({ buildSampleStyleData } = await import("@/lib/pdf/sample-data"));
  ({ GET } = await import("@/app/api/admin/change-requests/revisions/[revisionId]/proof/route"));
  proofs = await import("@/lib/change-requests/proofs");
});

beforeEach(() => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  asAdmin();
  resetFixtures();
  proofs.clearProofCache();
  pngCalls.length = 0;
  renderHtmlPng.mock.resetCalls();
});

const req = (revisionId: string, qs: string) =>
  new NextRequest(`http://localhost/api/admin/change-requests/revisions/${revisionId}/proof?${qs}`);
const params = (revisionId: string) => ({ params: Promise.resolve({ revisionId }) });
const call = (revisionId: string, qs: string) => GET(req(revisionId, qs), params(revisionId));
const ok = `styleId=${STYLE_ID}&side=after`;

// ── Gate ────────────────────────────────────────────────────────────────────

test("flag off → 404 for everyone, before any session check", async () => {
  delete process.env.CHANGE_REQUESTS_ENABLED;
  for (const who of [asAdmin, asReviewer, asAnon]) {
    who();
    assert.equal((await call("rev-draft", ok)).status, 404);
  }
  process.env.CHANGE_REQUESTS_ENABLED = "false";
  asAdmin();
  assert.equal((await call("rev-draft", ok)).status, 404);
  assert.equal(pngCalls.length, 0);
});

test("no session → 401; REVIEWER → 403 (ADMIN only)", async () => {
  asAnon();
  assert.equal((await call("rev-draft", ok)).status, 401);
  asReviewer();
  const res = await call("rev-draft", ok);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Requires role: ADMIN" });
  assert.equal(pngCalls.length, 0);
});

test("bad params → 400", async () => {
  for (const qs of [
    "side=after",
    `styleId=${STYLE_ID}`,
    `styleId=${STYLE_ID}&side=both`,
    `styleId=${STYLE_ID}&side=after&doc=-1`,
    `styleId=${STYLE_ID}&side=after&doc=one`,
    `styleId=${STYLE_ID}&side=after&suffix=`,
  ]) {
    assert.equal((await call("rev-draft", qs)).status, 400, qs);
  }
  assert.equal(pngCalls.length, 0);
});

// ── Not found ───────────────────────────────────────────────────────────────

test("ProofNotFoundError → 404: unknown revision, unknown style, style not using the layout, doc out of range", async () => {
  const unknownRevision = await call("bogus-revision", ok);
  assert.equal(unknownRevision.status, 404);
  assert.deepEqual(await unknownRevision.json(), { error: "Revision not found" });

  assert.equal((await call("rev-draft", "styleId=bogus-missing-style&side=after")).status, 404);

  const notUsing = await call("rev-draft", `styleId=${OTHER_STYLE_ID}&side=before`);
  assert.equal(notUsing.status, 404);
  assert.match((await notUsing.json()).error, /not configured/i);

  const outOfRange = await call("rev-draft", `${ok}&doc=1`);
  assert.equal(outOfRange.status, 404);
  assert.match((await outOfRange.json()).error, /out of range/);

  assert.equal((await call("rev-split", `${ok}&suffix=bogus-size`)).status, 404);
  assert.equal(pngCalls.length, 0, "nothing was rasterised");
});

// ── Render ──────────────────────────────────────────────────────────────────

test("200 image/png: before is the live layout, after is the draft, private cache", async () => {
  const before = await call("rev-draft", `styleId=${STYLE_ID}&side=before`);
  assert.equal(before.status, 200);
  assert.equal(before.headers.get("content-type"), "image/png");
  assert.equal(before.headers.get("cache-control"), "private, max-age=300");
  assert.equal(before.headers.get("x-proof-size-mm"), "50x30");
  assert.equal(before.headers.get("x-proof-doc"), "0");
  const bytes = Buffer.from(await before.arrayBuffer());
  assert.deepEqual(bytes.subarray(0, 8), PNG_SIGNATURE);

  const after = await call("rev-draft", `styleId=${STYLE_ID}&side=after`);
  assert.equal(after.status, 200);

  assert.equal(pngCalls.length, 2);
  assert.match(pngCalls[0].html, /LIVE TEXT/);
  assert.doesNotMatch(pngCalls[0].html, /DRAFT TEXT/);
  assert.match(pngCalls[1].html, /DRAFT TEXT/);
  assert.doesNotMatch(pngCalls[1].html, /LIVE TEXT/);
  // The style's real data went through the render, at the page's own box.
  assert.match(pngCalls[1].html, new RegExp(buildSampleStyleData().styleNumber));
  assert.deepEqual(
    pngCalls.map((c) => [c.widthMm, c.heightMm, c.scale]),
    [
      [50, 30, 3],
      [50, 30, 3],
    ],
  );
  // The draft was rendered, never written: the live layout is untouched.
  assert.deepEqual(layout.definition, rawDef("LIVE TEXT"));
});

test("a published revision's before is what was live when it was drafted", async () => {
  const res = await call("rev-published", `styleId=${STYLE_ID}&side=before`);
  assert.equal(res.status, 200);
  assert.match(pngCalls[0].html, /OLD TEXT/);
});

test("split output: ?suffix picks the document; the header names it", async () => {
  const res = await call("rev-split", `${ok}&suffix=M`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-proof-suffix"), "M");
  assert.match(pngCalls[0].html, /SPLIT M\b/);
  // By index too: doc 0 is the first size.
  const first = await call("rev-split", `${ok}&doc=0`);
  assert.equal(first.status, 200);
  assert.ok(first.headers.get("x-proof-suffix"));
});

test("cache: the same picture renders once; a builder autosave re-renders the before side", async () => {
  const qs = `styleId=${STYLE_ID}&side=before`;
  await call("rev-draft", qs);
  await call("rev-draft", qs);
  assert.equal(pngCalls.length, 1, "second request served from the cache");

  // Two concurrent asks for an uncached picture share one render.
  await Promise.all([call("rev-draft", ok), call("rev-draft", ok)]);
  assert.equal(pngCalls.length, 2);

  // The Output Builder autosaves onto the live row without bumping version.
  layout.definition = rawDef("AUTOSAVED TEXT");
  await call("rev-draft", qs);
  assert.equal(pngCalls.length, 3);
  assert.match(pngCalls[2].html, /AUTOSAVED TEXT/);

  // A failed render is not cached: the next ask renders again.
  renderHtmlPng.mock.mockImplementationOnce(async () => {
    throw new Error("browser went away");
  });
  const retryQs = `styleId=${STYLE_ID}&side=before&doc=0`;
  layout.definition = rawDef("RETRY TEXT");
  await assert.rejects(call("rev-draft", retryQs), /browser went away/);
  const retried = await call("rev-draft", retryQs);
  assert.equal(retried.status, 200);
  assert.match(pngCalls.at(-1)!.html, /RETRY TEXT/);

  // The revision is looked up on every request, cached picture or not.
  revisions = revisions.filter((r) => r.id !== "rev-draft");
  assert.equal((await call("rev-draft", retryQs)).status, 404);
});

// ── Picks for a revision (field values from the real render data) ───────────

test("loadFieldValues: the value the print sees — the output's pins applied; unreadable styles left out", async () => {
  const values = await proofs.loadFieldValues(
    [STYLE_ID, PINNED_STYLE_ID, POLYBAG_STYLE_ID, "bogus-missing-style", STYLE_ID],
    ["customerName", "polybagQty"],
    { layoutId: LAYOUT_ID },
  );
  assert.deepEqual(Object.keys(values).sort(), [STYLE_ID, PINNED_STYLE_ID, POLYBAG_STYLE_ID].sort());
  assert.equal(values[STYLE_ID].customerName, buildSampleStyleData().customerName);
  assert.equal(values[PINNED_STYLE_ID].customerName, "Pinned Co");
  assert.equal(values[POLYBAG_STYLE_ID].polybagQty, "5");
  assert.equal(values[STYLE_ID].polybagQty, "");
  // Without the layout: the bare style data, no output pins.
  const bare = await proofs.loadFieldValues([PINNED_STYLE_ID], ["customerName"]);
  assert.equal(bare[PINNED_STYLE_ID].customerName, buildSampleStyleData().customerName);
  assert.deepEqual(await proofs.loadFieldValues([STYLE_ID], []), {});
});

test("pickProofsForRevision: the new polybag block shown where it prints and proven hidden where it doesn't", async () => {
  const row = (styleId: string, changed: boolean) => ({
    styleId,
    styleLabel: styleId,
    poNumber: "PO-0000",
    variantKey: KEY,
    changed,
    reviewStatus: "PENDING_REVIEW" as const,
    uploaded: false,
    emailed: false,
    inFlight: false,
  });
  const picks = await proofs.pickProofsForRevision({
    revisionId: "rev-polybag",
    impact: { rows: [row(POLYBAG_STYLE_ID, true), row(STYLE_ID, false)] },
  });
  assert.deepEqual(
    picks.map((p) => [p.reason, p.styleId, p.note]),
    [
      ["changed", POLYBAG_STYLE_ID, 'changes · pending review; polybagQty = "5" → shows'],
      ["control", STYLE_ID, "no change, expected; polybagQty empty → hidden (no change)"],
    ],
  );
  await assert.rejects(
    proofs.pickProofsForRevision({ revisionId: "bogus-revision", impact: { rows: [] } }),
    proofs.ProofNotFoundError,
  );
  assert.equal(pngCalls.length, 0, "picking renders no pictures");
});
