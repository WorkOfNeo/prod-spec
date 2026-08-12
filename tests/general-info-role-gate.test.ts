// Role-gate + blast-radius test for /api/admin/prod-specs/[id]/general-info —
// the narrow single-column endpoint that lets REVIEWERs (not just ADMINs) write
// a Prod Spec's "General information" prose.
//
// Two things are under test, and the second is the important one:
//
//   1. The gate: ADMIN and REVIEWER pass, any other signed-in role is 403'd
//      before the DB is touched, no session is 401'd.
//   2. THE WRITE IS ONE COLUMN. This route exists precisely because the full
//      ProdSpec PATCH auto-activates a draft spec on any content change
//      (`hasOtherChange` there counts generalInfoMd), which would let a
//      reviewer's typo fix arm a half-configured spec for job auto-enqueue.
//      The assertions below pin the update payload to generalInfoMd alone — if
//      someone later widens this handler, these fail.
//
// Drives the REAL route handler with a mocked session and a spy `db`, so the
// gate is exercised end-to-end WITHOUT the live Railway DB.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// ── Mutable session state the auth mock reads at call time ──────────────────
let sessionState: { session: unknown; role: string | null } = { session: null, role: null };
function asAdmin() {
  sessionState = { session: { user: { id: "admin-1", email: "admin@example.com" } }, role: "ADMIN" };
}
function asReviewer() {
  sessionState = { session: { user: { id: "rev-1", email: "reviewer@example.com" } }, role: "REVIEWER" };
}
function asViewer() {
  // Signed in, but neither ADMIN nor REVIEWER — must be refused.
  sessionState = { session: { user: { id: "v-1", email: "viewer@example.com" } }, role: "VIEWER" };
}
function asAnon() {
  sessionState = { session: null, role: null };
}

// ── Side-effect spies ───────────────────────────────────────────────────────
type UpdateArgs = { where: { id: string }; data: Record<string, unknown> };
let lastUpdate: UpdateArgs | null = null;

const findUnique = mock.fn(async () => ({
  id: "spec-1",
  name: "Acme · Shoes",
  generalInfoMd: "existing text",
}) as unknown);
const update = mock.fn(async (args: UpdateArgs) => {
  lastUpdate = args;
  return { generalInfoMd: (args.data.generalInfoMd as string | null) ?? null, name: "Acme · Shoes" };
});
const logCreate = mock.fn(async () => ({}));

before(() => {
  // The real canReview from @/lib/roles stays un-mocked — the gate's actual
  // predicate is what's under test.
  mock.module("@/lib/auth-server", {
    namedExports: { getSessionWithRole: async () => sessionState },
  });
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        prodSpec: { findUnique, update },
        log: { create: logCreate },
      },
    },
  });
});

beforeEach(() => {
  findUnique.mock.resetCalls();
  update.mock.resetCalls();
  logCreate.mock.resetCalls();
  lastUpdate = null;
});

async function loadPatch() {
  const mod = await import("@/app/api/admin/prod-specs/[id]/general-info/route");
  return mod.PATCH as (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
}
const ctx = { params: Promise.resolve({ id: "spec-1" }) };

async function patch(body?: unknown) {
  const PATCH = await loadPatch();
  const req = new NextRequest("http://localhost/api/admin/prod-specs/spec-1/general-info", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await PATCH(req, ctx);
  let parsed: unknown = null;
  try {
    parsed = await res.clone().json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: parsed as { error?: string; ok?: boolean; markdown?: string } | null };
}

// ── The gate ────────────────────────────────────────────────────────────────

test("REVIEWER may write General information (this is the whole point)", async () => {
  asReviewer();
  const { status, body } = await patch({ markdown: "# Hello\n\nSupplier hands over the pictogram." });
  assert.equal(status, 200, "reviewer must be allowed through");
  assert.equal(body?.ok, true);
  assert.equal(update.mock.callCount(), 1, "the write actually happened");
});

test("ADMIN may write General information", async () => {
  asAdmin();
  const { status } = await patch({ markdown: "admin text" });
  assert.equal(status, 200);
  assert.equal(update.mock.callCount(), 1);
});

test("a non-review role (VIEWER) is refused with 403 before any DB work", async () => {
  asViewer();
  const { status, body } = await patch({ markdown: "nope" });
  assert.equal(status, 403);
  assert.match(body?.error ?? "", /ADMIN or REVIEWER/, "403 body names the allowed roles");
  assert.equal(findUnique.mock.callCount(), 0, "gate blocks before touching the DB");
  assert.equal(update.mock.callCount(), 0);
});

test("no session is rejected with 401", async () => {
  asAnon();
  const { status } = await patch({ markdown: "nope" });
  assert.equal(status, 401);
  assert.equal(update.mock.callCount(), 0);
});

// ── The blast radius ────────────────────────────────────────────────────────

test("the write touches generalInfoMd and NOTHING else", async () => {
  asReviewer();
  await patch({ markdown: "some prose" });
  assert.ok(lastUpdate, "update was called");
  assert.deepEqual(
    Object.keys(lastUpdate!.data).sort(),
    ["generalInfoMd"],
    "this endpoint must write exactly one column — see the route comment",
  );
  assert.equal(lastUpdate!.where.id, "spec-1");
});

test("the write never sets `active` — prose must not activate a draft spec", async () => {
  asReviewer();
  await patch({ markdown: "some prose" });
  assert.equal(
    "active" in lastUpdate!.data,
    false,
    "auto-activation is the full ProdSpec PATCH's behaviour and must not leak here",
  );
});

test("blank markdown clears the column to null (suppresses the pages)", async () => {
  asReviewer();
  await patch({ markdown: "   \n  " });
  assert.equal(lastUpdate!.data.generalInfoMd, null, "whitespace-only ⇒ null, matching the main PATCH");
});

// ── Input guards ────────────────────────────────────────────────────────────

test("a non-string markdown is rejected with 400 and never written", async () => {
  asReviewer();
  const { status } = await patch({ markdown: 42 });
  assert.equal(status, 400);
  assert.equal(update.mock.callCount(), 0);
});

test("an unknown prod spec is 404'd, not silently created", async () => {
  asReviewer();
  findUnique.mock.mockImplementationOnce(async () => null as unknown);
  const { status } = await patch({ markdown: "text" });
  assert.equal(status, 404);
  assert.equal(update.mock.callCount(), 0);
});
