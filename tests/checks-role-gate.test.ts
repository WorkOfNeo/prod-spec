// Role gate for the /checks endpoint, driven through the REAL route handler
// with a mocked session. AUTH_DISABLED forces ADMIN in dev, so the only way to
// exercise REVIEWER and anonymous is to mock the session — the same approach
// admin-role-gate.test.ts takes, and for the same reason.
//
// The gate here is canReview (ADMIN or REVIEWER), NOT isAdmin: auditing the
// folder an order ships from is a reviewer's job. What must never pass is an
// unauthenticated caller or a role with neither, on EITHER verb — the POST is
// the one that deletes.
//
// Requires Node's module-mock API:
//   node --experimental-test-module-mocks --import tsx --test "tests/**/*.test.ts"
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

type Role = "ADMIN" | "REVIEWER" | "SUPPLIER" | null;
let sessionState: { session: unknown; role: Role } = { session: null, role: null };
const as = (role: Exclude<Role, null>) => {
  sessionState = { session: { user: { id: `${role}-1`, email: `${role}@example.com` } }, role };
};
const asAnon = () => {
  sessionState = { session: null, role: null };
};

// Side-effect spies. Every one of these MUST stay uncalled for a refused
// request — a 403 that still ran the check would be a gate in name only.
const resolvePoSuppliers = mock.fn(async () => [{ supplierId: "sup-1", supplierName: "Supplier One" }]);
const runPoChecks = mock.fn(async () => ({
  poNumber: "PO-TEST-1",
  supplierId: "sup-1",
  supplierName: "Supplier One",
  state: "ok",
  message: "",
  folderUrl: null,
  poFolderUrl: null,
  folderPath: null,
  styles: [],
  sections: [],
  checkedAt: new Date().toISOString(),
}));
const applyCheckActions = mock.fn(async () => ({
  poNumber: "PO-TEST-1",
  applied: [],
  done: 0,
  refused: 0,
  failed: 0,
  report: null,
}));
const loadCheckHistory = mock.fn(async () => [] as unknown[]);

class ApplyChecksError extends Error {
  constructor(
    public httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

before(() => {
  // The real canReview from @/lib/roles stays un-mocked — the gate's actual
  // predicate is what is under test.
  mock.module("@/lib/auth-server", {
    namedExports: { getSessionWithRole: async () => sessionState },
  });
  mock.module("@/lib/checks/run-po-checks", {
    namedExports: { runPoChecks, resolvePoSuppliers },
  });
  mock.module("@/lib/checks/apply-actions", {
    namedExports: { applyCheckActions, loadCheckHistory, ApplyChecksError },
  });
});

beforeEach(() => {
  resolvePoSuppliers.mock.resetCalls();
  runPoChecks.mock.resetCalls();
  applyCheckActions.mock.resetCalls();
  loadCheckHistory.mock.resetCalls();
});

const getReq = () => new NextRequest("http://localhost/api/admin/checks?po=PO-TEST-1");
const postReq = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/checks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET: anonymous is refused, and the folder is never read", async () => {
  const { GET } = await import("../src/app/api/admin/checks/route");
  asAnon();
  const res = await GET(getReq());
  assert.equal(res.status, 401);
  assert.equal(runPoChecks.mock.callCount(), 0);
  assert.equal(resolvePoSuppliers.mock.callCount(), 0);
});

test("GET: a role with neither ADMIN nor REVIEWER is refused", async () => {
  const { GET } = await import("../src/app/api/admin/checks/route");
  as("SUPPLIER");
  const res = await GET(getReq());
  assert.equal(res.status, 403);
  assert.equal(runPoChecks.mock.callCount(), 0);
});

test("GET: REVIEWER and ADMIN both get the check — this is a reviewer's job", async () => {
  const { GET } = await import("../src/app/api/admin/checks/route");
  for (const role of ["REVIEWER", "ADMIN"] as const) {
    as(role);
    const res = await GET(getReq());
    assert.equal(res.status, 200, `${role} should be allowed`);
  }
  assert.equal(runPoChecks.mock.callCount(), 2);
});

test("POST: anonymous is refused, and NOTHING is applied", async () => {
  const { POST } = await import("../src/app/api/admin/checks/route");
  asAnon();
  const res = await POST(postReq({ supplierId: "sup-1", poNumber: "PO-TEST-1", actions: [] }));
  assert.equal(res.status, 401);
  assert.equal(applyCheckActions.mock.callCount(), 0);
});

test("POST: a role with neither ADMIN nor REVIEWER is refused, and NOTHING is applied", async () => {
  const { POST } = await import("../src/app/api/admin/checks/route");
  as("SUPPLIER");
  const res = await POST(postReq({ supplierId: "sup-1", poNumber: "PO-TEST-1", actions: [] }));
  assert.equal(res.status, 403);
  assert.equal(applyCheckActions.mock.callCount(), 0);
});

test("POST: REVIEWER may apply, and the acting user is passed through for the audit trail", async () => {
  const { POST } = await import("../src/app/api/admin/checks/route");
  as("REVIEWER");
  const res = await POST(
    postReq({
      supplierId: "sup-1",
      poNumber: "PO-TEST-1",
      actions: [{ checkId: "cover-pages", itemId: "item-1", fileName: "a.pdf", action: "delete" }],
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(applyCheckActions.mock.callCount(), 1);
  const arg = (applyCheckActions.mock.calls[0].arguments as unknown[])[0] as { userId: string; userEmail: string };
  assert.equal(arg.userId, "REVIEWER-1");
  assert.equal(arg.userEmail, "REVIEWER@example.com");
});

test("POST: junk in the actions array is dropped, not passed on", async () => {
  // The server re-validates everything against a fresh check anyway, but a
  // handler that forwards arbitrary shapes is one refactor away from trusting
  // one. Only the two known checks and the two known actions survive parsing.
  const { POST } = await import("../src/app/api/admin/checks/route");
  as("ADMIN");
  await POST(
    postReq({
      supplierId: "sup-1",
      poNumber: "PO-TEST-1",
      actions: [
        { checkId: "cover-pages", itemId: "keep", fileName: "a.pdf", action: "delete" },
        { checkId: "made-up-check", itemId: "drop", fileName: "b.pdf", action: "delete" },
        { checkId: "cover-pages", itemId: "drop", fileName: "c.pdf", action: "move" },
        { checkId: "cover-pages", fileName: "d.pdf", action: "delete" },
        "not an object",
        null,
      ],
    }),
  );
  const arg = (applyCheckActions.mock.calls[0].arguments as unknown[])[0] as { actions: Array<{ itemId: string }> };
  assert.deepEqual(
    arg.actions.map((a) => a.itemId),
    ["keep"],
  );
});

test("POST: a PO with no supplier id is a 400, never an unscoped apply", async () => {
  const { POST } = await import("../src/app/api/admin/checks/route");
  as("ADMIN");
  const res = await POST(postReq({ poNumber: "PO-TEST-1", actions: [] }));
  assert.equal(res.status, 400);
  assert.equal(applyCheckActions.mock.callCount(), 0);
});
