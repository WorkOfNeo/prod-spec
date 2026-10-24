// Gates and behaviour of the review screen's read routes, through the REAL
// handlers with a mocked session, store, db, revisions, impact and proofs:
//
//   GET /api/admin/change-requests/[id]                       ADMIN, or the
//                                                             REVIEWER who
//                                                             filed it (who
//                                                             gets the
//                                                             requester view)
//   GET /api/admin/change-requests/revisions/[id]/diff        ADMIN
//   GET /api/admin/change-requests/revisions/[id]/proofs      ADMIN
//
// All 404 while CHANGE_REQUESTS_ENABLED is off, before the session is read.
// Fixtures are synthetic. Runs under:
//   node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

type Role = "ADMIN" | "REVIEWER" | "SUPPLIER" | null;
type Row = Record<string, unknown>;
let sessionState: { session: unknown; role: Role } = { session: null, role: null };
const getSessionWithRole = mock.fn(async () => sessionState);
const as = (role: Exclude<Role, null>, id = `${role.toLowerCase()}-1`) => {
  sessionState = { session: { user: { id, email: `${role.toLowerCase()}@example.com` } }, role };
};
const asAnon = () => {
  sessionState = { session: null, role: null };
};

const T0 = new Date("2026-10-20T10:00:00Z");

function requestDetail(): Row {
  return {
    id: "req-1",
    number: 3,
    title: "Polybag sticker · PO-0000",
    status: "IN_REVIEW",
    message: "Missing quantity",
    source: "REQUESTER",
    createdById: "reviewer-1",
    customerId: null,
    poNumber: "PO-0000",
    styleId: "style-1",
    createdAt: T0,
    updatedAt: T0,
    outputs: [
      {
        id: "out-1",
        requestId: "req-1",
        position: 0,
        label: "Polybag sticker",
        variantKey: "layout:bogus-layout",
        layoutId: "bogus-layout",
        styleId: "style-1",
        text: "Show the quantity",
        status: "IN_REVIEW",
        currentRevisionId: "rev-1",
        draftCount: 1,
        awaitingToken: null,
        codeSpec: null,
        impact: null,
        rejectReason: null,
        approvedById: null,
        approvedAt: null,
        publishedAt: null,
        firstTryApproved: null,
        createdAt: T0,
        updatedAt: T0,
      },
    ],
    attachments: [],
    messages: [],
    steps: [
      {
        id: "s1",
        requestId: "req-1",
        outputId: "out-1",
        kind: "model_turn",
        summary: "Turn 1",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.001,
        detail: null,
        createdAt: T0,
      },
    ],
  };
}

function rawDef(lines: string[]) {
  return {
    pages: [
      {
        id: "p1",
        title: "",
        widthMm: 50,
        heightMm: 30,
        blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 6 }, fontPt: 9, lines }],
      },
    ],
  };
}

let detail: Row | null;
let revision: Row | null;
let outputRow: Row | null;
const SUMMARY = {
  rows: [
    {
      styleId: "style-1",
      styleLabel: "Style 1",
      poNumber: "PO-0000",
      variantKey: "layout:bogus-layout",
      changed: true,
      reviewStatus: "PENDING_REVIEW",
      uploaded: false,
      emailed: false,
      inFlight: false,
    },
  ],
  counts: {
    styles: 1,
    docs: 1,
    changed: 1,
    unchanged: 0,
    changedByStatus: { PENDING_REVIEW: 1, APPROVED: 0, REJECTED: 0, NONE: 0 },
    approvedChanged: 0,
    deliveredChanged: 0,
  },
};
const impactForRevision = mock.fn(async (_id: string) => ({ ...SUMMARY, durationMs: 5 }));
const computeImpact = mock.fn(async (_input: Row) => ({ ...SUMMARY, durationMs: 9 }));
const pickProofsForRevision = mock.fn(async (input: Row) => [
  { styleId: "style-1", styleLabel: "Style 1", variantKey: "layout:bogus-layout", suffix: null, reason: "changed", note: String(input.focusStyleId) },
]);
const revisionFindMany = mock.fn(async () => [
  {
    id: "rev-1",
    number: 1,
    status: "DRAFT",
    authorKind: "AGENT",
    note: null,
    parentRevisionId: null,
    publishedVersion: null,
    changeRequestOutputId: "out-1",
    createdAt: T0,
  },
]);

before(() => {
  mock.module("@/lib/auth-server", { namedExports: { getSessionWithRole } });
  mock.module("@/lib/change-requests/store", {
    namedExports: { getRequestDetail: async (id: string) => (detail && detail.id === id ? detail : null) },
  });
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        outputLayoutRevision: { findMany: revisionFindMany },
        user: {
          findMany: async () => [
            { id: "reviewer-1", email: "reviewer@example.com" },
            { id: "admin-1", email: "admin@example.com" },
          ],
        },
        agentMemory: { findMany: async () => [] },
        changeRequestOutput: { findUnique: async () => outputRow },
      },
    },
  });
  mock.module("@/lib/output-layouts/revisions", {
    namedExports: { getRevision: async (id: string) => (revision && revision.id === id ? revision : null) },
  });
  mock.module("@/lib/change-requests/impact", { namedExports: { impactForRevision, computeImpact } });
  mock.module("@/lib/change-requests/proofs", { namedExports: { pickProofsForRevision } });
});

beforeEach(() => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  detail = requestDetail();
  revision = {
    id: "rev-1",
    status: "DRAFT",
    layoutId: "bogus-layout",
    changeRequestOutputId: "out-1",
    baseDefinition: rawDef(["Line A"]),
    definition: rawDef(["Line A", "{{polybagQty}} PCS"]),
  };
  outputRow = { styleId: "style-1", currentRevisionId: "rev-1", impact: SUMMARY };
  getSessionWithRole.mock.resetCalls();
  impactForRevision.mock.resetCalls();
  computeImpact.mock.resetCalls();
  pickProofsForRevision.mock.resetCalls();
  revisionFindMany.mock.resetCalls();
});
afterEach(() => {
  delete process.env.CHANGE_REQUESTS_ENABLED;
});

const get = (path: string) => new NextRequest(`http://localhost/api/admin/change-requests/${path}`);
const idCtx = (id = "req-1") => ({ params: Promise.resolve({ id }) });
const revCtx = (revisionId = "rev-1") => ({ params: Promise.resolve({ revisionId }) });

// ── GET [id] ────────────────────────────────────────────────────────────────

test("detail: 404 while the flag is off, before the session is read", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/[id]/route");
  delete process.env.CHANGE_REQUESTS_ENABLED;
  as("ADMIN");
  assert.equal((await GET(get("req-1"), idCtx())).status, 404);
  assert.equal(getSessionWithRole.mock.callCount(), 0);
});

test("detail: anonymous → 401, a role that can't review → 403, another reviewer → 403", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/[id]/route");
  asAnon();
  assert.equal((await GET(get("req-1"), idCtx())).status, 401);
  as("SUPPLIER");
  assert.equal((await GET(get("req-1"), idCtx())).status, 403);
  as("REVIEWER", "reviewer-2");
  assert.equal((await GET(get("req-1"), idCtx())).status, 403);
});

test("detail: the filing REVIEWER may read it — the requester view, no drafts or run log", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/[id]/route");
  as("REVIEWER", "reviewer-1");
  const res = await GET(get("req-1"), idCtx());
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.admin, false);
  assert.equal(view.ref, "R-0003");
  assert.deepEqual(view.steps, []);
  assert.deepEqual(view.outputs[0].revisions, []);
  assert.equal(revisionFindMany.mock.callCount(), 0, "revisions aren't even read for a requester");
});

test("detail: ADMIN gets the whole view with each output's revisions; unknown → 404", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/[id]/route");
  as("ADMIN");
  const res = await GET(get("req-1"), idCtx());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const view = await res.json();
  assert.equal(view.admin, true);
  assert.deepEqual(view.outputs[0].revisions.map((r: Row) => r.id), ["rev-1"]);
  assert.equal(view.steps.length, 1);
  assert.equal(view.requester, "reviewer@example.com");
  assert.equal((await GET(get("nope"), idCtx("nope"))).status, 404);
});

// ── diff ────────────────────────────────────────────────────────────────────

test("diff: 404 with the flag off; 401; REVIEWER → 403", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/revisions/[revisionId]/diff/route");
  delete process.env.CHANGE_REQUESTS_ENABLED;
  as("ADMIN");
  assert.equal((await GET(get("revisions/rev-1/diff"), revCtx())).status, 404);
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  asAnon();
  assert.equal((await GET(get("revisions/rev-1/diff"), revCtx())).status, 401);
  as("REVIEWER");
  assert.equal((await GET(get("revisions/rev-1/diff"), revCtx())).status, 403);
});

test("diff: ADMIN gets the plain-words changes against the draft's base, plus both raw definitions", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/revisions/[revisionId]/diff/route");
  as("ADMIN");
  const res = await GET(get("revisions/rev-1/diff"), revCtx());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changes.length, 1);
  assert.equal(body.changes[0].kind, "text");
  assert.equal(body.changes[0].blockId, "b1");
  assert.deepEqual(body.before, revision!.baseDefinition);
  assert.deepEqual(body.after, revision!.definition);
  assert.equal((await GET(get("revisions/nope/diff"), revCtx("nope"))).status, 404);
});

// ── proofs ──────────────────────────────────────────────────────────────────

test("proofs: 404 with the flag off; 401; REVIEWER → 403; nothing is computed", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/revisions/[revisionId]/proofs/route");
  delete process.env.CHANGE_REQUESTS_ENABLED;
  as("ADMIN");
  assert.equal((await GET(get("revisions/rev-1/proofs"), revCtx())).status, 404);
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  asAnon();
  assert.equal((await GET(get("revisions/rev-1/proofs"), revCtx())).status, 401);
  as("REVIEWER");
  assert.equal((await GET(get("revisions/rev-1/proofs"), revCtx())).status, 403);
  assert.equal(pickProofsForRevision.mock.callCount(), 0);
});

test("proofs: the current draft uses the output's stored impact, focused on the output's style", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/revisions/[revisionId]/proofs/route");
  as("ADMIN");
  const res = await GET(get("revisions/rev-1/proofs"), revCtx());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(impactForRevision.mock.callCount(), 0);
  assert.deepEqual(body.impactCounts, SUMMARY.counts);
  assert.equal(body.picks.length, 1);
  const args = pickProofsForRevision.mock.calls[0].arguments[0];
  assert.equal(args.revisionId, "rev-1");
  assert.equal(args.focusStyleId, "style-1");
});

test("proofs: an older draft gets impactForRevision; a published one with nothing stored compares base → published", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/revisions/[revisionId]/proofs/route");
  as("ADMIN");
  outputRow = { styleId: "style-1", currentRevisionId: "rev-9", impact: SUMMARY };
  let res = await GET(get("revisions/rev-1/proofs"), revCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(impactForRevision.mock.calls[0].arguments, ["rev-1"]);

  revision!.status = "PUBLISHED";
  outputRow = { styleId: "style-1", currentRevisionId: "rev-1", impact: null };
  res = await GET(get("revisions/rev-1/proofs"), revCtx());
  assert.equal(res.status, 200);
  assert.equal(impactForRevision.mock.callCount(), 1);
  assert.equal(computeImpact.mock.callCount(), 1);
  assert.equal((computeImpact.mock.calls[0].arguments[0] as Row).layoutId, "bogus-layout");
});

test("proofs: a typed error answers with its status (too many styles → 422); unknown revision → 404", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/revisions/[revisionId]/proofs/route");
  as("ADMIN");
  outputRow = null;
  impactForRevision.mock.mockImplementationOnce(async () => {
    throw Object.assign(new Error("This layout prints on more than 400 styles"), { httpStatus: 422 });
  });
  const res = await GET(get("revisions/rev-1/proofs"), revCtx());
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /more than 400 styles/);
  assert.equal((await GET(get("revisions/nope/proofs"), revCtx("nope"))).status, 404);
});
