// Impact list: the loader (computeImpact / impactForRevision) and the ADMIN
// route GET /api/admin/change-requests/revisions/[revisionId]/impact.
//
// The pure comparison is tested in src/lib/change-requests/impact.test.ts. Here
// every dependency of the loader is mocked — the db, the per-output render,
// layout usage, the style render context and the current-output walk — so the
// tests pin what the loader does with them:
//
//   • styles come from stylesUsingLayout with limit + 1, and over the limit is
//     refused with a 422 before anything renders,
//   • each style's context is loaded ONCE and both sides render through
//     `definition` with the same context, production mode, files, no
//     unresolved pass — the live side from the layout row unless given,
//   • documents are joined with review status per doc key, delivery per base
//     output and in-flight jobs per style; a style that fails to render is an
//     error, not a row,
//   • the summary is cached on the change-request output only while the
//     revision is its current draft,
//   • the route answers 404 with the flag off, 401/403 before any work, 404 for
//     an unknown revision, 422 when too large, else the summary.
//
// Fixtures are synthetic. Runs under:
//   node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import type { LayoutDef } from "@/lib/output-layouts/schema";
import type { ImpactSummary } from "@/lib/change-requests/types";

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
const LAYOUT_ID = "bogus-layout";
const KEY = `layout:${LAYOUT_ID}`;

function rawDef(lines: string[]) {
  return {
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 50,
        heightMm: 30,
        blocks: [{ rect: { col: 0, row: 0, colSpan: 12, rowSpan: 6 }, fontPt: 9, lines }],
      },
    ],
  };
}

const LIVE_RAW = rawDef(["Line A"]);
// The proposal adds a line that prints on ONE document of style-a and on
// style-b only (see fakeRender's "only:" convention).
const PROPOSED_RAW = rawDef(["Line A", "only:style-a#m:NEW", "only:style-b:NEW"]);

// How each style renders: its documents, or a failure.
type StyleFixture = { suffixes: (string | null)[]; fail?: string };
const STYLE_FIXTURES: Record<string, StyleFixture> = {
  "style-a": { suffixes: ["s", "m"] },
  "style-b": { suffixes: [null] },
  "style-c": { suffixes: [null] },
  "style-broken": { suffixes: [null], fail: "Output not configured on this style's ProdSpec" },
};
const USAGE_ORDER = ["style-a", "style-b", "style-missing", "style-c", "style-broken"];
// "bulk-<n>" styles render one plain document (the concurrency test).
const fixtureFor = (styleId: string): StyleFixture | undefined =>
  STYLE_FIXTURES[styleId] ?? (styleId.startsWith("bulk-") ? { suffixes: [null] } : undefined);

function usage(styleId: string) {
  return {
    styleId,
    prodSpecId: "spec-1",
    label: `Label ${styleId}`,
    poNumber: "PO-0000",
    output: { variantKey: KEY, widthMm: 40, heightMm: 30, enabled: true },
  };
}

// Each line prints as is, except "only:<styleId>[#<suffix>]:<text>", which
// prints only on that style (or that one document of it).
function fakeHtml(styleId: string, suffix: string | null, def: LayoutDef): string {
  const lines = def.pages[0].blocks[0].lines.flatMap((line) => {
    const m = /^only:([^:#]+)(?:#([^:]+))?:(.*)$/.exec(line);
    if (!m) return [line];
    if (m[1] !== styleId || (m[2] !== undefined && m[2] !== suffix)) return [];
    return [m[3]];
  });
  return `<html>\n  <div>${lines.join("</div><div>")}</div>\n</html>\n`;
}

// ── Mock state ──────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
let layoutRows: Map<string, Row>;
let revisionRows: Map<string, Row>;
let queueRows: Row[];
let jobRows: Row[];
let currentOutputs: Map<string, Row[]>;
let usageStyles: string[];
let updateManyError: unknown = null;
let inFlight = 0;
let maxInFlight = 0;

const usageCalls: Array<{ layoutId: string; opts: unknown }> = [];
const ctxCalls: string[] = [];
const renderCalls: Array<{ ctx: unknown; input: Record<string, unknown> }> = [];
const currentOutputCalls: string[][] = [];
const queueCalls: Row[] = [];
const jobCalls: Row[] = [];
const updateManyCalls: Row[] = [];

const fakeDb = {
  outputLayout: {
    findUnique: async (args: { where: { id: string } }) => layoutRows.get(args.where.id) ?? null,
  },
  outputLayoutRevision: {
    findUnique: async (args: { where: { id: string } }) => revisionRows.get(args.where.id) ?? null,
  },
  supplierSendQueueItem: {
    findMany: async (args: { where: { styleId: { in: string[] }; variantKey: string } }) => {
      queueCalls.push(args as unknown as Row);
      return queueRows.filter(
        (r) => args.where.styleId.in.includes(r.styleId as string) && r.variantKey === args.where.variantKey,
      );
    },
  },
  job: {
    findMany: async (args: { where: { styleId: { in: string[] }; status: { in: string[] } } }) => {
      jobCalls.push(args as unknown as Row);
      return jobRows.filter(
        (j) => args.where.styleId.in.includes(j.styleId as string) && args.where.status.in.includes(j.status as string),
      );
    },
  },
  changeRequestOutput: {
    updateMany: async (args: Row) => {
      updateManyCalls.push(args);
      if (updateManyError) throw updateManyError;
      return { count: 1 };
    },
  },
};

type RouteModule = typeof import("@/app/api/admin/change-requests/revisions/[revisionId]/impact/route");
let GET: RouteModule["GET"];
let impact: typeof import("@/lib/change-requests/impact");
let RevisionNotFoundError: typeof import("@/lib/output-layouts/revisions").RevisionNotFoundError;
let ImpactSummarySchema: typeof import("@/lib/change-requests/types").ImpactSummarySchema;
let parseLayoutDef: typeof import("@/lib/output-layouts/schema").parseLayoutDef;
let infoLines: string[] = [];

before(async () => {
  mock.module("@/lib/auth-server", {
    namedExports: { getSessionWithRole: async () => sessionState },
  });
  mock.module("@/lib/db", { namedExports: { db: fakeDb } });
  mock.module("@/lib/output-layouts/usage", {
    namedExports: {
      stylesUsingLayout: async (layoutId: string, opts: { limit?: number }) => {
        usageCalls.push({ layoutId, opts });
        const all = usageStyles.map(usage);
        return opts.limit !== undefined ? all.slice(0, opts.limit) : all;
      },
    },
  });
  mock.module("@/lib/styles/render-context", {
    namedExports: {
      loadStyleRenderContext: async (styleId: string) => {
        ctxCalls.push(styleId);
        if (!fixtureFor(styleId)) return null;
        return { styleId, poSeq: null, styleData: {}, prodSpec: null, outputs: [], readiness: [] };
      },
    },
  });
  mock.module("@/lib/output-layouts/render-output", {
    namedExports: {
      renderStyleOutput: async (
        input: Record<string, unknown> & { ctx: { styleId: string }; definition: LayoutDef },
      ) => {
        renderCalls.push({ ctx: input.ctx, input });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        const fx = fixtureFor(input.ctx.styleId)!;
        if (fx.fail) throw new Error(fx.fail);
        return {
          docs: fx.suffixes.map((suffix) => ({
            suffix,
            html: fakeHtml(input.ctx.styleId, suffix, input.definition),
            widthMm: 50,
            heightMm: 30,
          })),
          unresolved: [],
        };
      },
    },
  });
  mock.module("@/lib/outputs/current-outputs", {
    namedExports: {
      getCurrentOutputsForStyles: async (ids: readonly string[]) => {
        currentOutputCalls.push([...ids]);
        return new Map(ids.map((id) => [id, currentOutputs.get(id) ?? []]));
      },
    },
  });

  impact = await import("@/lib/change-requests/impact");
  ({ GET } = await import("@/app/api/admin/change-requests/revisions/[revisionId]/impact/route"));
  ({ RevisionNotFoundError } = await import("@/lib/output-layouts/revisions"));
  ({ ImpactSummarySchema } = await import("@/lib/change-requests/types"));
  ({ parseLayoutDef } = await import("@/lib/output-layouts/schema"));
});

beforeEach(() => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  asAdmin();
  layoutRows = new Map([[LAYOUT_ID, { id: LAYOUT_ID, definition: structuredClone(LIVE_RAW) }]]);
  revisionRows = new Map([
    [
      "rev-current",
      {
        id: "rev-current",
        status: "DRAFT",
        layoutId: LAYOUT_ID,
        definition: structuredClone(PROPOSED_RAW),
        changeRequestOutputId: "cro-1",
      },
    ],
    [
      "rev-loose",
      {
        id: "rev-loose",
        status: "DRAFT",
        layoutId: LAYOUT_ID,
        definition: structuredClone(PROPOSED_RAW),
        changeRequestOutputId: null,
      },
    ],
    [
      // Published: the live layout now IS its definition.
      "rev-published",
      {
        id: "rev-published",
        status: "PUBLISHED",
        layoutId: LAYOUT_ID,
        definition: structuredClone(PROPOSED_RAW),
        baseDefinition: structuredClone(LIVE_RAW),
        changeRequestOutputId: "cro-1",
      },
    ],
    [
      "rev-replaced",
      {
        id: "rev-replaced",
        status: "SUPERSEDED",
        layoutId: LAYOUT_ID,
        definition: structuredClone(PROPOSED_RAW),
        changeRequestOutputId: "cro-1",
      },
    ],
  ]);
  usageStyles = [...USAGE_ORDER];
  currentOutputs = new Map([
    [
      "style-a",
      [
        { variantKey: `${KEY}#s`, reviewStatus: "APPROVED" },
        { variantKey: `${KEY}#m`, reviewStatus: "APPROVED" },
      ],
    ],
    ["style-b", [{ variantKey: KEY, reviewStatus: "PENDING_REVIEW" }]],
    ["style-c", [{ variantKey: KEY, reviewStatus: null }]],
  ]);
  queueRows = [
    { styleId: "style-a", variantKey: KEY, sharePointStatus: "UPLOADED", sentAt: null },
    // Another output of the same style: never read for this layout.
    { styleId: "style-b", variantKey: "care-label-01", sharePointStatus: "UPLOADED", sentAt: new Date(0) },
    { styleId: "style-c", variantKey: KEY, sharePointStatus: "PENDING", sentAt: new Date(0) },
  ];
  jobRows = [
    { styleId: "style-b", status: "RUNNING" },
    { styleId: "style-c", status: "AWAITING_REVIEW" },
  ];
  updateManyError = null;
  inFlight = 0;
  maxInFlight = 0;
  for (const list of [usageCalls, ctxCalls, renderCalls, currentOutputCalls, queueCalls, jobCalls, updateManyCalls]) {
    list.length = 0;
  }
  infoLines = [];
  mock.method(console, "info", (line: string) => {
    infoLines.push(line);
  });
});

afterEach(() => {
  mock.restoreAll();
});

const EXPECTED_ROWS = [
  {
    styleId: "style-a",
    styleLabel: "Label style-a",
    poNumber: "PO-0000",
    variantKey: `${KEY}#s`,
    changed: false,
    reviewStatus: "APPROVED",
    uploaded: true,
    emailed: false,
    inFlight: false,
  },
  {
    styleId: "style-a",
    styleLabel: "Label style-a",
    poNumber: "PO-0000",
    variantKey: `${KEY}#m`,
    changed: true,
    reviewStatus: "APPROVED",
    uploaded: true,
    emailed: false,
    inFlight: false,
  },
  {
    styleId: "style-b",
    styleLabel: "Label style-b",
    poNumber: "PO-0000",
    variantKey: KEY,
    changed: true,
    reviewStatus: "PENDING_REVIEW",
    uploaded: false,
    emailed: false,
    inFlight: true,
  },
  {
    styleId: "style-c",
    styleLabel: "Label style-c",
    poNumber: "PO-0000",
    variantKey: KEY,
    changed: false,
    reviewStatus: "NONE",
    uploaded: false,
    emailed: true,
    inFlight: false,
  },
];

const EXPECTED_COUNTS = {
  styles: 3,
  docs: 4,
  changed: 2,
  unchanged: 2,
  changedByStatus: { PENDING_REVIEW: 1, APPROVED: 1, REJECTED: 0, NONE: 0 },
  approvedChanged: 1,
  deliveredChanged: 1,
};

// ── computeImpact ───────────────────────────────────────────────────────────

test("computeImpact renders both sides per style and joins review, delivery and in-flight state", async () => {
  const proposedDef = parseLayoutDef(PROPOSED_RAW);
  const summary = await impact.computeImpact({ layoutId: LAYOUT_ID, proposedDef });

  assert.deepEqual(usageCalls, [{ layoutId: LAYOUT_ID, opts: { limit: 401 } }]);
  assert.deepEqual(summary.rows, EXPECTED_ROWS);
  assert.deepEqual(summary.counts, EXPECTED_COUNTS);
  assert.deepEqual(summary.errors, [
    { styleId: "style-missing", message: "Style not found" },
    { styleId: "style-broken", message: "Output not configured on this style's ProdSpec" },
  ]);
  assert.equal(typeof summary.durationMs, "number");
  assert.ok(summary.durationMs! >= 0);
  assert.deepEqual(ImpactSummarySchema.parse(summary), summary);

  // The context once per style, shared by both renders of it.
  assert.deepEqual([...ctxCalls].sort(), [...USAGE_ORDER].sort());
  const liveDef = parseLayoutDef(LIVE_RAW);
  for (const styleId of Object.keys(STYLE_FIXTURES)) {
    const calls = renderCalls.filter((c) => (c.ctx as { styleId: string }).styleId === styleId);
    const expected = STYLE_FIXTURES[styleId].fail ? 1 : 2; // a failed live render stops the style
    assert.equal(calls.length, expected, styleId);
    assert.ok(calls.every((c) => c.ctx === calls[0].ctx), `${styleId}: one context for both renders`);
    for (const c of calls) {
      assert.equal(c.input.variantKey, KEY);
      assert.equal(c.input.mode, "production");
      assert.equal(c.input.documents, "files");
      assert.equal(c.input.withUnresolved, false);
      assert.equal(c.input.styleId, undefined, "rendered from the loaded context, not re-loaded by id");
    }
    assert.deepEqual(calls[0].input.definition, liveDef, `${styleId}: the live side renders through definition too`);
    if (expected === 2) assert.equal(calls[1].input.definition, proposedDef);
  }

  // The join reads only the styles that rendered, and only this layout's output.
  assert.deepEqual(currentOutputCalls, [["style-a", "style-b", "style-c"]]);
  assert.equal(queueCalls.length, 1);
  assert.deepEqual(queueCalls[0].where, { styleId: { in: ["style-a", "style-b", "style-c"] }, variantKey: KEY });
  assert.deepEqual((jobCalls[0].where as Row).status, { in: ["QUEUED", "RUNNING"] });

  // One log line: counts and timing, no labels or PO numbers.
  assert.equal(infoLines.length, 1);
  assert.match(infoLines[0], /impact layout=bogus-layout/);
  assert.match(infoLines[0], /styles=3 docs=4 changed=2/);
  assert.match(infoLines[0], /errors=2/);
  assert.match(infoLines[0], /\d+ms/);
  assert.doesNotMatch(infoLines[0], /Label|PO-0000/);
});

test("computeImpact renders at most four styles at once, and keeps the styles' order", async () => {
  usageStyles = Array.from({ length: 10 }, (_, i) => `bulk-${i}`);
  const summary = await impact.computeImpact({ layoutId: LAYOUT_ID, proposedDef: parseLayoutDef(PROPOSED_RAW) });
  assert.equal(maxInFlight, impact.IMPACT_CONCURRENCY);
  assert.equal(impact.IMPACT_CONCURRENCY, 4);
  assert.deepEqual(
    summary.rows.map((r) => r.styleId),
    usageStyles,
  );
  assert.equal(summary.counts.styles, 10);
});

test("computeImpact uses a given currentDef as the before side", async () => {
  const currentDef = parseLayoutDef(PROPOSED_RAW);
  const summary = await impact.computeImpact({ layoutId: LAYOUT_ID, proposedDef: currentDef, currentDef });
  assert.equal(renderCalls[0].input.definition, currentDef);
  assert.equal(summary.counts.changed, 0);
  assert.equal(summary.counts.unchanged, 4);
});

test("computeImpact refuses more styles than the limit before rendering anything", async () => {
  await assert.rejects(
    impact.computeImpact({ layoutId: LAYOUT_ID, proposedDef: parseLayoutDef(PROPOSED_RAW), limit: 2 }),
    (err: unknown) => {
      assert.ok(err instanceof impact.ImpactTooLargeError);
      assert.equal(err.httpStatus, 422);
      assert.match(err.message, /more than 2 styles/);
      return true;
    },
  );
  assert.deepEqual(usageCalls[0].opts, { limit: 3 });
  assert.equal(renderCalls.length, 0);
  assert.equal(ctxCalls.length, 0);

  // Exactly at the limit is fine.
  usageStyles = ["style-a", "style-b"];
  const summary = await impact.computeImpact({
    layoutId: LAYOUT_ID,
    proposedDef: parseLayoutDef(PROPOSED_RAW),
    limit: 2,
  });
  assert.equal(summary.counts.styles, 2);
});

test("computeImpact: unknown layout → not found; no styles → an empty summary, no join", async () => {
  await assert.rejects(
    impact.computeImpact({ layoutId: "nope", proposedDef: parseLayoutDef(PROPOSED_RAW) }),
    (err: unknown) => err instanceof RevisionNotFoundError && err.httpStatus === 404,
  );

  usageStyles = [];
  const summary = await impact.computeImpact({ layoutId: LAYOUT_ID, proposedDef: parseLayoutDef(PROPOSED_RAW) });
  assert.deepEqual(summary.rows, []);
  assert.deepEqual(summary.counts.changedByStatus, { PENDING_REVIEW: 0, APPROVED: 0, REJECTED: 0, NONE: 0 });
  assert.deepEqual(summary.errors, []);
  assert.equal(currentOutputCalls.length + queueCalls.length + jobCalls.length, 0);
});

// ── impactForRevision ───────────────────────────────────────────────────────

test("impactForRevision compares the revision with the live layout and caches it on its output", async () => {
  const summary = await impact.impactForRevision("rev-current");
  assert.deepEqual(summary.rows, EXPECTED_ROWS);
  assert.deepEqual(summary.counts, EXPECTED_COUNTS);
  // Styles render concurrently, so look at one style's pair.
  const pair = renderCalls.filter((c) => (c.ctx as { styleId: string }).styleId === "style-a");
  assert.deepEqual(pair[0].input.definition, parseLayoutDef(LIVE_RAW));
  assert.deepEqual(pair[1].input.definition, parseLayoutDef(PROPOSED_RAW));

  assert.equal(updateManyCalls.length, 1);
  // Conditional on the revision still being the output's current draft.
  assert.deepEqual(updateManyCalls[0].where, { id: "cro-1", currentRevisionId: "rev-current" });
  assert.deepEqual((updateManyCalls[0].data as Row).impact, summary);
});

test("impactForRevision: a PUBLISHED revision compares its base with itself, against no live state, and never caches", async () => {
  // What is live now is the published definition: against it nothing would change.
  layoutRows.set(LAYOUT_ID, { id: LAYOUT_ID, definition: structuredClone(PROPOSED_RAW) });
  const summary = await impact.impactForRevision("rev-published");
  assert.deepEqual(summary.rows, EXPECTED_ROWS);
  const pair = renderCalls.filter((c) => (c.ctx as { styleId: string }).styleId === "style-a");
  assert.deepEqual(pair[0].input.definition, parseLayoutDef(LIVE_RAW));
  assert.deepEqual(pair[1].input.definition, parseLayoutDef(PROPOSED_RAW));
  assert.equal(updateManyCalls.length, 0, "the approval's stored impact is never overwritten");
});

test("impactForRevision: a replaced or discarded draft is compared with the live layout but never cached", async () => {
  const summary = await impact.impactForRevision("rev-replaced");
  assert.equal(summary.counts.changed, 2);
  assert.equal(updateManyCalls.length, 0);
});

test("impactForRevision: no output → no cache; unknown → 404; a missing table keeps the list", async () => {
  await impact.impactForRevision("rev-loose");
  assert.equal(updateManyCalls.length, 0);

  await assert.rejects(
    impact.impactForRevision("rev-nope"),
    (err: unknown) => err instanceof RevisionNotFoundError && err.httpStatus === 404,
  );

  updateManyError = Object.assign(new Error("The table does not exist"), { code: "P2021" });
  const summary = await impact.impactForRevision("rev-current");
  assert.equal(summary.counts.changed, 2);

  updateManyError = Object.assign(new Error("connection lost"), { code: "P1001" });
  await assert.rejects(impact.impactForRevision("rev-current"), /connection lost/);
});

// ── Route ───────────────────────────────────────────────────────────────────

const req = (id: string) =>
  new NextRequest(`http://localhost/api/admin/change-requests/revisions/${id}/impact`);
const params = (revisionId: string) => ({ params: Promise.resolve({ revisionId }) });

test("route: 404 with the flag off, whoever asks, and nothing runs", async () => {
  for (const flag of [undefined, "false", "1"]) {
    if (flag === undefined) delete process.env.CHANGE_REQUESTS_ENABLED;
    else process.env.CHANGE_REQUESTS_ENABLED = flag;
    for (const as of [asAdmin, asReviewer, asAnon]) {
      as();
      const res = await GET(req("rev-current"), params("rev-current"));
      assert.equal(res.status, 404, `flag=${flag}`);
    }
  }
  assert.equal(usageCalls.length + renderCalls.length, 0);
});

test("route: no session → 401, reviewer → 403, before any work", async () => {
  asAnon();
  const anon = await GET(req("rev-current"), params("rev-current"));
  assert.equal(anon.status, 401);
  assert.deepEqual(await anon.json(), { error: "Not signed in" });

  asReviewer();
  const rev = await GET(req("rev-current"), params("rev-current"));
  assert.equal(rev.status, 403);
  assert.deepEqual(await rev.json(), { error: "Requires role: ADMIN" });

  assert.equal(usageCalls.length + renderCalls.length + updateManyCalls.length, 0);
});

test("route: unknown revision → 404", async () => {
  const res = await GET(req("rev-nope"), params("rev-nope"));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Revision not found" });
});

test("route: an admin gets the summary", async () => {
  const res = await GET(req("rev-current"), params("rev-current"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = ImpactSummarySchema.parse(await res.json()) as ImpactSummary;
  assert.deepEqual(body.rows, EXPECTED_ROWS);
  assert.deepEqual(body.counts, EXPECTED_COUNTS);
  assert.equal(body.errors?.length, 2);
});

test("route: too many styles → 422 with the message", async () => {
  usageStyles = Array.from({ length: impact.IMPACT_STYLE_LIMIT + 1 }, (_, i) => `style-${i}`);
  const res = await GET(req("rev-current"), params("rev-current"));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, new RegExp(`more than ${impact.IMPACT_STYLE_LIMIT} styles`));
  assert.equal(renderCalls.length, 0);
});
