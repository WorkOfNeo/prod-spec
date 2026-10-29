// Gate and error mapping of "Not a code gap", through the REAL handler with a
// mocked session, gap.ts and job:
//
//   POST /api/admin/change-request-outputs/[id]/withdraw-gap   { note? }
//
// ADMIN only; 404 while CHANGE_REQUESTS_ENABLED is off, before the session is
// read. What must never happen on a refused request: the hand-off being
// withdrawn or a run starting. publish-errors.ts stays real, so the mapping
// under test (409 for the wrong state, 404 for a missing output) is the one
// that ships. Runs under:
//   node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { OutputNotFoundError, OutputStateError } from "../src/lib/change-requests/publish-errors";

type Role = "ADMIN" | "REVIEWER" | "SUPPLIER" | null;
let sessionState: { session: unknown; role: Role } = { session: null, role: null };
const getSessionWithRole = mock.fn(async () => sessionState);
const as = (role: Exclude<Role, null>, id = `${role.toLowerCase()}-1`) => {
  sessionState = { session: { user: { id, email: `${role.toLowerCase()}@example.com` } }, role };
};
const asAnon = () => {
  sessionState = { session: null, role: null };
};

type Start = (outputId: string) => Promise<{ started: boolean; reason?: string }>;
let withdrawThrows: unknown = null;
// Calls the starter it is handed, as the real one does, so the test sees what
// the route starts the run with.
const withdrawCodeGap = mock.fn(async (outputId: string, opts: { userId: string; note: string | null }, start: Start) => {
  if (withdrawThrows) throw withdrawThrows;
  const res = await start(outputId);
  return { tokenKey: "cartonEan13", started: res.started, ...(res.started ? {} : { reason: res.reason }) };
});
// Typed with both arguments so the tests can read what the run was started with.
const startChangeRequestRun = mock.fn<(outputId: string, opts: { trigger: string; userId: string | null }) => Promise<{ started: boolean; reason?: string }>>(
  async () => ({ started: true }),
);

before(() => {
  mock.module("@/lib/auth-server", { namedExports: { getSessionWithRole } });
  mock.module("@/lib/change-requests/gap", { namedExports: { withdrawCodeGap } });
  mock.module("@/lib/change-requests/agent/job", { namedExports: { startChangeRequestRun } });
});

beforeEach(() => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  withdrawThrows = null;
  for (const fn of [getSessionWithRole, withdrawCodeGap, startChangeRequestRun]) fn.mock.resetCalls();
});
afterEach(() => {
  delete process.env.CHANGE_REQUESTS_ENABLED;
});

const load = () => import("../src/app/api/admin/change-request-outputs/[id]/withdraw-gap/route");
const ctx = (id = "out-1") => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new NextRequest("http://localhost/api/admin/change-request-outputs/out-1/withdraw-gap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("404 while the flag is off, before the session is read", async () => {
  const { POST } = await load();
  delete process.env.CHANGE_REQUESTS_ENABLED;
  as("ADMIN");
  assert.equal((await POST(post({}), ctx())).status, 404);
  assert.equal(getSessionWithRole.mock.callCount(), 0);
  assert.equal(withdrawCodeGap.mock.callCount(), 0);
});

test("anonymous → 401, REVIEWER / SUPPLIER → 403, nothing withdrawn or started", async () => {
  const { POST } = await load();
  asAnon();
  assert.equal((await POST(post({}), ctx())).status, 401);
  as("REVIEWER");
  assert.equal((await POST(post({}), ctx())).status, 403);
  as("SUPPLIER");
  assert.equal((await POST(post({}), ctx())).status, 403);
  assert.equal(withdrawCodeGap.mock.callCount(), 0);
  assert.equal(startChangeRequestRun.mock.callCount(), 0);
});

test("ADMIN withdraws with a note; the agent restarts on the thread (trigger comment) as that admin", async () => {
  const { POST } = await load();
  as("ADMIN");
  const res = await POST(post({ note: "  Use {{barcode:cartonEan13}}.  " }), ctx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tokenKey: "cartonEan13", started: true });
  const [id, opts] = withdrawCodeGap.mock.calls[0].arguments;
  assert.equal(id, "out-1");
  assert.deepEqual(opts, { userId: "admin-1", note: "Use {{barcode:cartonEan13}}." });
  assert.deepEqual(startChangeRequestRun.mock.calls[0].arguments, ["out-1", { trigger: "comment", userId: "admin-1" }]);
});

test("an empty body withdraws without a note; a refused start is answered as such, not as an error", async () => {
  const { POST } = await load();
  as("ADMIN");
  startChangeRequestRun.mock.mockImplementationOnce(async () => ({ started: false, reason: "busy" }));
  const res = await POST(post(), ctx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { tokenKey: "cartonEan13", started: false, reason: "busy" });
  assert.equal(withdrawCodeGap.mock.calls[0].arguments[1].note, null);
});

test("a note over 5000 characters → 400; the wrong state → 409 with the status; a missing output → 404", async () => {
  const { POST } = await load();
  as("ADMIN");
  assert.equal((await POST(post({ note: "x".repeat(5001) }), ctx())).status, 400);
  assert.equal(withdrawCodeGap.mock.callCount(), 0);

  withdrawThrows = new OutputStateError("Only an output waiting for code can be marked as not a code gap; this one is in review.", "IN_REVIEW");
  let res = await POST(post({}), ctx());
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /in review/);

  withdrawThrows = new OutputNotFoundError("out-1");
  res = await POST(post({}), ctx());
  assert.equal(res.status, 404);
  assert.equal(startChangeRequestRun.mock.callCount(), 0);
});
