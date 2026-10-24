// Gates and error mapping of the three admin actions on a change-request
// output, through the REAL handlers with a mocked session and publish.ts:
//
//   POST /api/admin/change-request-outputs/[id]/approve          { revisionId, force? }
//   POST /api/admin/change-request-outputs/[id]/reject           { reason }
//   POST /api/admin/change-request-outputs/[id]/rerun-approved   { styleIds? }
//
// ADMIN only (design §2: a human admin approves every publish and every rerun
// of approved documents). 404 while CHANGE_REQUESTS_ENABLED is off, before the
// session is read. What must never happen on a refused request: the action
// running. publish-errors.ts stays real, so the mapping under test is the one
// that ships. Runs under:
//   node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

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

let actionThrows: unknown = null;
const act = (result: Row) =>
  mock.fn<(id: string, opts: Row) => Promise<Row>>(async () => {
    if (actionThrows) throw actionThrows;
    return result;
  });
const approveOutput = act({ publishedVersion: 4 });
const rejectOutput = act({ discarded: 1 });
const rerunApprovedDocuments = act({ enqueued: 2 });

before(() => {
  mock.module("@/lib/auth-server", { namedExports: { getSessionWithRole } });
  mock.module("@/lib/change-requests/publish", {
    namedExports: { approveOutput, rejectOutput, rerunApprovedDocuments },
  });
});

beforeEach(() => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  actionThrows = null;
  for (const fn of [getSessionWithRole, approveOutput, rejectOutput, rerunApprovedDocuments]) fn.mock.resetCalls();
});
afterEach(() => {
  delete process.env.CHANGE_REQUESTS_ENABLED;
});

const ctx = (id = "out-1") => ({ params: Promise.resolve({ id }) });
const post = (action: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/admin/change-request-outputs/out-1/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const ROUTES = {
  approve: {
    load: () => import("../src/app/api/admin/change-request-outputs/[id]/approve/route"),
    fn: approveOutput,
    body: { revisionId: "rev-2" },
  },
  reject: { load: () => import("../src/app/api/admin/change-request-outputs/[id]/reject/route"), fn: rejectOutput, body: { reason: "No" } },
  "rerun-approved": {
    load: () => import("../src/app/api/admin/change-request-outputs/[id]/rerun-approved/route"),
    fn: rerunApprovedDocuments,
    body: {},
  },
} as const;

for (const [name, route] of Object.entries(ROUTES)) {
  test(`${name}: 404 while the flag is off, before the session is read`, async () => {
    const { POST } = await route.load();
    delete process.env.CHANGE_REQUESTS_ENABLED;
    as("ADMIN");
    assert.equal((await POST(post(name, route.body), ctx())).status, 404);
    assert.equal(getSessionWithRole.mock.callCount(), 0);
    assert.equal(route.fn.mock.callCount(), 0);
  });

  test(`${name}: anonymous → 401, REVIEWER → 403, nothing runs`, async () => {
    const { POST } = await route.load();
    asAnon();
    assert.equal((await POST(post(name, route.body), ctx())).status, 401);
    as("REVIEWER");
    assert.equal((await POST(post(name, route.body), ctx())).status, 403);
    as("SUPPLIER");
    assert.equal((await POST(post(name, route.body), ctx())).status, 403);
    assert.equal(route.fn.mock.callCount(), 0);
  });
}

test("approve: ADMIN approves the draft they reviewed, with the session's id and email", async () => {
  const { POST } = await ROUTES.approve.load();
  as("ADMIN");
  let res = await POST(post("approve", { revisionId: "rev-2" }), ctx());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { publishedVersion: 4 });
  assert.deepEqual(approveOutput.mock.calls[0].arguments, [
    "out-1",
    { userId: "admin-1", userEmail: "admin@example.com", revisionId: "rev-2", force: false },
  ]);

  res = await POST(post("approve", { revisionId: "rev-2", force: true }), ctx());
  assert.equal(res.status, 200);
  assert.equal((approveOutput.mock.calls[1].arguments[1] as Row).force, true);

  assert.equal((await POST(post("approve", { revisionId: "rev-2", force: "yes" }), ctx())).status, 400);
});

test("approve: without the reviewed draft's id it is a 400 and nothing runs", async () => {
  const { POST } = await ROUTES.approve.load();
  as("ADMIN");
  for (const body of [undefined, {}, { force: true }, { revisionId: "" }, { revisionId: 42 }]) {
    const res = await POST(post("approve", body), ctx());
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, /which draft/);
  }
  assert.equal(approveOutput.mock.callCount(), 0);
});

test("approve: a newer draft than the one reviewed is a 409 'reload'", async () => {
  const { POST } = await ROUTES.approve.load();
  const { OutputStateError } = await import("../src/lib/change-requests/publish-errors");
  as("ADMIN");
  actionThrows = new OutputStateError("A newer draft exists — reload");
  const res = await POST(post("approve", { revisionId: "rev-1" }), ctx());
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "A newer draft exists — reload" });
});

test("approve: a conflict is a 409 that carries what moved; a failing gate a 422 with details; a superseded draft a 409", async () => {
  const { POST } = await ROUTES.approve.load();
  const { OutputStateError } = await import("../src/lib/change-requests/publish-errors");
  as("ADMIN");
  const conflict = { baseVersion: 3, liveVersion: 4, versionChanged: true, definitionChanged: false };
  actionThrows = Object.assign(new Error("Can't publish: the layout was published again"), { httpStatus: 409, conflict });
  let res = await POST(post("approve", ROUTES.approve.body), ctx());
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "Can't publish: the layout was published again", conflict });

  actionThrows = Object.assign(new Error("Layout has invalid tokens"), { httpStatus: 422, details: ["Unknown token"] });
  res = await POST(post("approve", ROUTES.approve.body), ctx());
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: "Layout has invalid tokens", details: ["Unknown token"] });

  actionThrows = new OutputStateError("This draft was replaced by another publish; ask the agent for a new draft");
  res = await POST(post("approve", ROUTES.approve.body), ctx());
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /ask the agent for a new draft/);
});

test("approve: an untyped failure is not dressed up as a 4xx", async () => {
  const { POST } = await ROUTES.approve.load();
  as("ADMIN");
  actionThrows = new Error("database down");
  await assert.rejects(POST(post("approve", ROUTES.approve.body), ctx()), /database down/);
});

test("reject: a reason is required (1..500) — 400 and nothing runs; a good one is passed trimmed", async () => {
  const { POST } = await ROUTES.reject.load();
  as("ADMIN");
  for (const body of [{}, { reason: "   " }, { reason: "x".repeat(501) }, undefined]) {
    assert.equal((await POST(post("reject", body), ctx())).status, 400, JSON.stringify(body));
  }
  assert.equal(rejectOutput.mock.callCount(), 0);
  const res = await POST(post("reject", { reason: "  Wrong customer  " }), ctx());
  assert.equal(res.status, 200);
  assert.deepEqual(rejectOutput.mock.calls[0].arguments, ["out-1", { userId: "admin-1", reason: "Wrong customer" }]);
});

test("rerun-approved: ADMIN may limit it to styles; a malformed list is a 400", async () => {
  const { POST } = await ROUTES["rerun-approved"].load();
  as("ADMIN");
  let res = await POST(post("rerun-approved", { styleIds: ["style-1", "style-2"] }), ctx());
  assert.equal(res.status, 200);
  assert.deepEqual(rerunApprovedDocuments.mock.calls[0].arguments, [
    "out-1",
    { userId: "admin-1", userEmail: "admin@example.com", styleIds: ["style-1", "style-2"] },
  ]);
  res = await POST(post("rerun-approved"), ctx());
  assert.equal(res.status, 200);
  assert.equal((rerunApprovedDocuments.mock.calls[1].arguments[1] as Row).styleIds, null);
  assert.equal((await POST(post("rerun-approved", { styleIds: [] }), ctx())).status, 400);
  assert.equal((await POST(post("rerun-approved", { styleIds: "style-1" }), ctx())).status, 400);
});
