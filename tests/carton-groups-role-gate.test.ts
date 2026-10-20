// Role-gate + input-guard tests for the carton GROUP routes — the multi-style
// carton that REVIEWERs (not just ADMINs) may create and remove.
//
// Drives the REAL route handlers with a mocked session and stubs every
// side-effecting dependency, so the gates are exercised end-to-end WITHOUT the
// live Railway DB, Puppeteer, or email. Mirrors carton-customize-role-gate.
//
// Clean stopping points AFTER the guard but BEFORE any work:
//   • POST   — a missing mainStyleId 400s straight after the role check.
//   • DELETE — a missing reason 400s inside removeCartonGroup before any read.
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
  sessionState = {
    session: { user: { id: "rev-1", email: "reviewer@example.com" } },
    role: "REVIEWER",
  };
}
function asViewer() {
  // Signed in, but NEITHER ADMIN nor REVIEWER — must be refused.
  sessionState = { session: { user: { id: "v-1", email: "viewer@example.com" } }, role: "VIEWER" };
}
function asAnon() {
  sessionState = { session: null, role: null };
}

// ── Side-effect spies ───────────────────────────────────────────────────────
const styleFindUnique = mock.fn(async () => null);
const cartonGroupFindUnique = mock.fn(async () => null);

before(() => {
  // Real canReview from @/lib/roles stays un-mocked — the gate's actual
  // predicate is what's under test.
  mock.module("@/lib/auth-server", {
    namedExports: { getSessionWithRole: async () => sessionState },
  });
  // Mocking @/lib/db also covers transitive importers, so no real pg client is
  // instantiated by the group library the DELETE route pulls in.
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        cartonGroup: { findUnique: cartonGroupFindUnique, update: mock.fn(async () => ({})) },
        cartonGroupStyle: { findFirst: mock.fn(async () => null) },
        jobAsset: { findUnique: mock.fn(async () => null) },
        style: { findUnique: styleFindUnique, findMany: mock.fn(async () => []) },
        job: { count: mock.fn(async () => 0), create: mock.fn(async () => ({ id: "j-1" })) },
        log: { create: mock.fn(async () => ({})) },
        $transaction: mock.fn(async () => []),
      },
    },
  });
  // The group library itself is NOT stubbed — its guards are part of what these
  // tests cover. Only the render seam is, so importing it never pulls in the
  // Puppeteer stack (it is never reached on any path here).
  mock.module("@/lib/output-layouts/carton-render", {
    namedExports: {
      renderCartonCustomization: mock.fn(async () => ({
        ok: false as const,
        status: 400,
        error: "unused",
      })),
      CARTON_MAX: 2000,
    },
  });
});

beforeEach(() => {
  styleFindUnique.mock.resetCalls();
  cartonGroupFindUnique.mock.resetCalls();
});

async function loadPost() {
  const mod = await import("@/app/api/admin/carton-groups/route");
  return mod.POST as (req: NextRequest) => Promise<Response>;
}
async function loadDelete() {
  const mod = await import("@/app/api/admin/carton-groups/[id]/route");
  return mod.DELETE as (
    req: NextRequest,
    ctx: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
}

function req(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

// ── POST /api/admin/carton-groups ───────────────────────────────────────────

test("POST — anonymous is refused with 401 and never reaches the group library", async () => {
  asAnon();
  const POST = await loadPost();
  const res = await POST(req("http://localhost/api/admin/carton-groups", "POST", {}));
  assert.equal(res.status, 401);
  assert.equal(styleFindUnique.mock.callCount(), 0);
});

test("POST — a signed-in non-reviewer is refused with 403", async () => {
  asViewer();
  const POST = await loadPost();
  const res = await POST(
    req("http://localhost/api/admin/carton-groups", "POST", {
      mainStyleId: "s-1",
      otherStyleIds: ["s-2"],
      variantKey: "layout:abc",
    }),
  );
  assert.equal(res.status, 403);
  assert.equal(styleFindUnique.mock.callCount(), 0);
});

test("POST — a REVIEWER passes the gate (grouping is part of reviewing)", async () => {
  asReviewer();
  const POST = await loadPost();
  const res = await POST(
    req("http://localhost/api/admin/carton-groups", "POST", {
      mainStyleId: "s-1",
      otherStyleIds: ["s-2"],
      variantKey: "layout:abc",
    }),
  );
  // The mocked style lookup returns null, so the real library 404s — proof the
  // request got past the gate and into the group logic.
  assert.equal(res.status, 404);
  assert.equal(styleFindUnique.mock.callCount(), 1);
});

test("POST — an ADMIN passes the gate too", async () => {
  asAdmin();
  const POST = await loadPost();
  const res = await POST(
    req("http://localhost/api/admin/carton-groups", "POST", {
      mainStyleId: "s-1",
      otherStyleIds: ["s-2"],
      variantKey: "layout:abc",
    }),
  );
  assert.equal(res.status, 404);
  assert.equal(styleFindUnique.mock.callCount(), 1);
});

test("POST — a reviewer with no mainStyleId 400s without doing any work", async () => {
  asReviewer();
  const POST = await loadPost();
  const res = await POST(
    req("http://localhost/api/admin/carton-groups", "POST", { variantKey: "layout:abc" }),
  );
  assert.equal(res.status, 400);
  assert.equal(styleFindUnique.mock.callCount(), 0);
});

// ── DELETE /api/admin/carton-groups/[id] ────────────────────────────────────

test("DELETE — anonymous is refused with 401 and never reads the group", async () => {
  asAnon();
  const DELETE = await loadDelete();
  const res = await DELETE(req("http://localhost/api/admin/carton-groups/g-1", "DELETE", {}), {
    params: Promise.resolve({ id: "g-1" }),
  });
  assert.equal(res.status, 401);
  assert.equal(cartonGroupFindUnique.mock.callCount(), 0);
});

test("DELETE — a signed-in non-reviewer is refused with 403", async () => {
  asViewer();
  const DELETE = await loadDelete();
  const res = await DELETE(
    req("http://localhost/api/admin/carton-groups/g-1", "DELETE", { reason: "wrong" }),
    { params: Promise.resolve({ id: "g-1" }) },
  );
  assert.equal(res.status, 403);
  assert.equal(cartonGroupFindUnique.mock.callCount(), 0);
});

test("DELETE — ungrouping without a reason is refused, and nothing is read", async () => {
  // The reason is not decoration: it is what the audit note on the PO quotes
  // back, and the only record of WHY a supplier-visible file must be deleted.
  asReviewer();
  const DELETE = await loadDelete();
  const res = await DELETE(
    req("http://localhost/api/admin/carton-groups/g-1", "DELETE", { reason: "   " }),
    { params: Promise.resolve({ id: "g-1" }) },
  );
  assert.equal(res.status, 400);
  assert.equal(cartonGroupFindUnique.mock.callCount(), 0);
});

test("DELETE — a reviewer with a reason passes the gate and reaches the lookup", async () => {
  asReviewer();
  const DELETE = await loadDelete();
  const res = await DELETE(
    req("http://localhost/api/admin/carton-groups/g-1", "DELETE", {
      reason: "Supplier packs them separately",
    }),
    { params: Promise.resolve({ id: "g-1" }) },
  );
  // The mocked lookup returns null, so the handler 404s — proof it got past the
  // guard and into the real removal logic.
  assert.equal(res.status, 404);
  assert.equal(cartonGroupFindUnique.mock.callCount(), 1);
});
