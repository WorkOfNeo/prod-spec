// Role-gate + input-guard test for POST /api/admin/styles/[id]/carton-customize
// — the in-review carton customization that REVIEWERs (not just ADMINs) may run.
// Drives the REAL route handler with a mocked session and stubs every
// side-effecting dependency, so the gate is exercised end-to-end WITHOUT the
// live Railway DB, Puppeteer, or email.
//
// The handler 409s the moment it sees an in-flight job (db.job.count → 1) —
// that's the clean stopping point AFTER the role guard but BEFORE any
// render/persist, so a "passes the gate" case proves pass-through without
// mocking the whole generation stack.
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
  // A signed-in user whose role is NEITHER ADMIN nor REVIEWER — must be refused.
  sessionState = { session: { user: { id: "v-1", email: "viewer@example.com" } }, role: "VIEWER" };
}
function asAnon() {
  sessionState = { session: null, role: null };
}

// ── Side-effect spies ───────────────────────────────────────────────────────
// count → 1 makes the handler return 409 right after the guards (no render).
const jobCount = mock.fn(async () => 1);
const renderCartonCustomization = mock.fn(async () => ({ ok: false as const, status: 400, error: "unused" }));

before(() => {
  // Real canReview from @/lib/roles stays un-mocked — the gate's actual
  // predicate is what's under test.
  mock.module("@/lib/auth-server", {
    namedExports: { getSessionWithRole: async () => sessionState },
  });
  // Mocking @/lib/db also covers transitive importers, so no real pg client
  // is instantiated.
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        job: {
          count: jobCount,
          create: mock.fn(async () => ({ id: "job-1" })),
          update: mock.fn(async () => ({})),
        },
        style: { findUnique: mock.fn(async () => ({ prodSpecId: null })) },
        jobAsset: { create: mock.fn(async () => ({})) },
        log: { create: mock.fn(async () => ({})) },
        $transaction: mock.fn(async () => []),
      },
    },
  });
  // Stub the render helper so importing the route never pulls in the
  // Puppeteer/render stack (it's never called on the 409 path anyway).
  mock.module("@/lib/output-layouts/carton-render", {
    namedExports: { renderCartonCustomization, CARTON_MAX: 2000 },
  });
  mock.module("@/lib/notifications/user-notifications", {
    namedExports: { notifyReviewReady: mock.fn(async () => 0) },
  });
  mock.module("@/lib/settings/app-settings", {
    namedExports: { getReviewNotificationEmails: async () => [] },
  });
  mock.module("@/lib/review-flow/claim", {
    namedExports: { claimReviewIfUnclaimed: mock.fn(async () => true) },
  });
});

beforeEach(() => {
  jobCount.mock.resetCalls();
  renderCartonCustomization.mock.resetCalls();
});

async function load() {
  const mod = await import("@/app/api/admin/styles/[id]/carton-customize/route");
  return mod.POST as (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
}
const ctx = { params: Promise.resolve({ id: "bogus-id" }) };

function post(body?: unknown) {
  return new NextRequest("http://localhost/api/admin/styles/bogus-id/carton-customize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function call(POST: Awaited<ReturnType<typeof load>>, body?: unknown) {
  const res = await POST(post(body), ctx);
  let parsed: unknown = null;
  try {
    parsed = await res.clone().json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: parsed as { error?: string; ok?: boolean } | null };
}

const NUMBERING_BODY = { variantKey: "layout:abc", total: 200 };

test("REVIEWER passes the gate (this is the whole point) and reaches generation", async () => {
  const POST = await load();
  asReviewer();
  const { status } = await call(POST, NUMBERING_BODY);
  assert.notEqual(status, 401, "reviewer must not be unauthorized");
  assert.notEqual(status, 403, "reviewer must NOT be forbidden — they may customize");
  assert.equal(status, 409, "in-flight stub 409s — i.e. execution proceeded past the guards");
  assert.equal(jobCount.mock.callCount(), 1, "reviewer reached the in-flight check");
});

test("ADMIN passes the gate", async () => {
  const POST = await load();
  asAdmin();
  const { status } = await call(POST, NUMBERING_BODY);
  assert.notEqual(status, 401);
  assert.notEqual(status, 403);
  assert.equal(status, 409);
  assert.equal(jobCount.mock.callCount(), 1);
});

test("a non-review role (VIEWER) is refused with 403 before any work", async () => {
  const POST = await load();
  asViewer();
  const { status, body } = await call(POST, NUMBERING_BODY);
  assert.equal(status, 403, "only ADMIN/REVIEWER may customize");
  assert.match(body?.error ?? "", /ADMIN or REVIEWER/, "403 body names the allowed roles");
  assert.equal(jobCount.mock.callCount(), 0, "gate blocks before touching the DB");
});

test("no session is rejected with 401", async () => {
  const POST = await load();
  asAnon();
  const { status } = await call(POST, NUMBERING_BODY);
  assert.equal(status, 401);
  assert.equal(jobCount.mock.callCount(), 0);
});

test("numbering + multi-style in one request is allowed (the capabilities combine)", async () => {
  const POST = await load();
  asReviewer();
  const { status } = await call(POST, { variantKey: "layout:abc", total: 200, siblingIds: ["s2"] });
  assert.notEqual(status, 400, "combining numbering and multiple styles must not be rejected");
  assert.equal(status, 409, "combined request proceeds past the guards to the in-flight check");
  assert.equal(jobCount.mock.callCount(), 1, "combined request reached the in-flight check");
});
