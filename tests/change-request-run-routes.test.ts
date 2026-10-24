// Gates for the two routes that start the change-request agent, driven through
// the REAL handlers with a mocked session, store and job:
//
//   POST /api/admin/change-requests/[id]/run       ADMIN only
//   POST /api/admin/change-requests/[id]/messages  ADMIN only
//
// Change requests are ADMIN-only for now: every other role — the REVIEWER who
// filed the request included, even answering the agent's question — is a 403
// before the request is read. (The messages route keeps a requester branch for
// when filing opens to reviewers; the role gate refuses them first.)
//
// Both 404 for everyone while CHANGE_REQUESTS_ENABLED is off. What must never
// happen on a refused request: a run starting or a message being stored.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

type Role = "ADMIN" | "REVIEWER" | "SUPPLIER" | null;
let sessionState: { session: unknown; role: Role } = { session: null, role: null };
const as = (role: Exclude<Role, null>, id = `${role.toLowerCase()}-1`) => {
  sessionState = { session: { user: { id, email: `${role.toLowerCase()}@example.com` } }, role };
};
const asAnon = () => {
  sessionState = { session: null, role: null };
};

type Output = { id: string; status: string; label: string };
let detail: { id: string; createdById: string; outputs: Output[] } | null;

type StartResult = { started: true } | { started: false; reason: string };
// Typed with both arguments so the tests can read what each run was started with.
const startChangeRequestRun = mock.fn<(outputId: string, opts: { trigger: string; userId: string | null }) => Promise<StartResult>>(
  async (outputId) =>
    outputId === "out-busy" ? { started: false, reason: "The agent is already working on this output" } : { started: true },
);
const appendMessage = mock.fn(async (m: Record<string, unknown>) => ({ id: "msg-1", createdAt: new Date(0), ...m }));
const getRequestDetail = mock.fn(async (id: string) => (detail && detail.id === id ? detail : null));

before(() => {
  mock.module("@/lib/auth-server", { namedExports: { getSessionWithRole: async () => sessionState } });
  mock.module("@/lib/change-requests/store", { namedExports: { getRequestDetail, appendMessage } });
  mock.module("@/lib/change-requests/agent/job", { namedExports: { startChangeRequestRun } });
});

beforeEach(() => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  startChangeRequestRun.mock.resetCalls();
  appendMessage.mock.resetCalls();
  getRequestDetail.mock.resetCalls();
  detail = {
    id: "req-1",
    createdById: "reviewer-1",
    outputs: [
      { id: "out-new", status: "NEW", label: "Polybag sticker" },
      { id: "out-failed", status: "FAILED", label: "Carton label" },
      { id: "out-review", status: "IN_REVIEW", label: "Hang tag" },
      { id: "out-info", status: "NEEDS_INFO", label: "Size sticker" },
      { id: "out-done", status: "PUBLISHED", label: "Care label" },
    ],
  };
});
afterEach(() => {
  delete process.env.CHANGE_REQUESTS_ENABLED;
});

const ctx = (id = "req-1") => ({ params: Promise.resolve({ id }) });
const post = (path: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/admin/change-requests/req-1/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// ── /run ────────────────────────────────────────────────────────────────────

test("run: 404 for everyone while the flag is off, and nothing starts", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/run/route");
  delete process.env.CHANGE_REQUESTS_ENABLED;
  as("ADMIN");
  const res = await POST(post("run", {}), ctx());
  assert.equal(res.status, 404);
  assert.equal(startChangeRequestRun.mock.callCount(), 0);
});

test("run: anonymous → 401, REVIEWER → 403, nothing starts", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/run/route");
  asAnon();
  assert.equal((await POST(post("run", {}), ctx())).status, 401);
  as("REVIEWER");
  assert.equal((await POST(post("run", {}), ctx())).status, 403);
  assert.equal(startChangeRequestRun.mock.callCount(), 0);
  assert.equal(getRequestDetail.mock.callCount(), 0);
});

test("run: ADMIN with no output starts every NEW and FAILED output", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/run/route");
  as("ADMIN");
  const res = await POST(post("run"), ctx());
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { started: ["out-new", "out-failed"], skipped: [] });
  assert.deepEqual(
    startChangeRequestRun.mock.calls.map((c) => c.arguments),
    [
      ["out-new", { trigger: "new", userId: "admin-1" }],
      ["out-failed", { trigger: "new", userId: "admin-1" }],
    ],
  );
});

test("run: ADMIN with one output starts only that one; busy or settled outputs are skipped with a reason", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/run/route");
  as("ADMIN");
  let res = await POST(post("run", { outputId: "out-review" }), ctx());
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { started: ["out-review"], skipped: [] });

  res = await POST(post("run", { outputId: "out-done" }), ctx());
  assert.deepEqual(await res.json(), { started: [], skipped: [{ outputId: "out-done", reason: "The output is published" }] });

  detail!.outputs.push({ id: "out-busy", status: "IN_REVIEW", label: "x" });
  res = await POST(post("run", { outputId: "out-busy" }), ctx());
  assert.deepEqual(await res.json(), {
    started: [],
    skipped: [{ outputId: "out-busy", reason: "The agent is already working on this output" }],
  });
});

test("run: unknown request or output → 404; a malformed body → 400", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/run/route");
  as("ADMIN");
  assert.equal((await POST(post("run", {}), ctx("nope"))).status, 404);
  assert.equal((await POST(post("run", { outputId: "out-elsewhere" }), ctx())).status, 404);
  assert.equal((await POST(post("run", { outputId: 42 }), ctx())).status, 400);
  assert.equal(startChangeRequestRun.mock.callCount(), 0);
});

// ── /messages ───────────────────────────────────────────────────────────────

test("messages: 404 for everyone while the flag is off", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/messages/route");
  delete process.env.CHANGE_REQUESTS_ENABLED;
  as("ADMIN");
  assert.equal((await POST(post("messages", { body: "hi" }), ctx())).status, 404);
  assert.equal(appendMessage.mock.callCount(), 0);
});

test("messages: anonymous → 401, a role that isn't ADMIN → 403, nothing stored", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/messages/route");
  asAnon();
  assert.equal((await POST(post("messages", { body: "hi" }), ctx())).status, 401);
  as("SUPPLIER");
  assert.equal((await POST(post("messages", { body: "hi" }), ctx())).status, 403);
  assert.equal(appendMessage.mock.callCount(), 0);
});

test("messages: a REVIEWER on someone else's request → 403, nothing read, stored or started", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/messages/route");
  as("REVIEWER", "reviewer-2");
  const res = await POST(post("messages", { outputId: "out-info", body: "Size M" }), ctx());
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Requires role: ADMIN" });
  assert.equal(getRequestDetail.mock.callCount(), 0);
  assert.equal(appendMessage.mock.callCount(), 0);
  assert.equal(startChangeRequestRun.mock.callCount(), 0);
});

test("messages: the filing REVIEWER gets 403 too — even answering a NEEDS_INFO output — nothing read, stored or started", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/messages/route");
  as("REVIEWER", "reviewer-1");
  for (const body of [
    { outputId: "out-info", body: "Size M" },
    { outputId: "out-review", body: "Make it bold" },
    { body: "General remark" },
  ]) {
    const res = await POST(post("messages", body), ctx());
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: "Requires role: ADMIN" }, JSON.stringify(body));
  }
  assert.equal(getRequestDetail.mock.callCount(), 0);
  assert.equal(appendMessage.mock.callCount(), 0);
  assert.equal(startChangeRequestRun.mock.callCount(), 0);
});

test("messages: an ADMIN answer on a NEEDS_INFO output is stored and restarts the agent (trigger answer)", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/messages/route");
  as("ADMIN");
  const res = await POST(post("messages", { outputId: "out-info", body: "  Size M  " }), ctx());
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.started, true);
  assert.equal(json.message.body, "Size M");
  assert.deepEqual(appendMessage.mock.calls[0].arguments[0], {
    requestId: "req-1",
    outputId: "out-info",
    authorKind: "USER",
    authorUserId: "admin-1",
    kind: "message",
    body: "Size M",
  });
  assert.deepEqual(startChangeRequestRun.mock.calls[0].arguments, ["out-info", { trigger: "answer", userId: "admin-1" }]);
});

test("messages: an ADMIN comment on a draft in review restarts the agent (trigger comment)", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/messages/route");
  as("ADMIN");
  const res = await POST(post("messages", { outputId: "out-review", body: "Make it bold" }), ctx());
  assert.equal(res.status, 201);
  assert.equal((await res.json()).started, true);
  assert.deepEqual(startChangeRequestRun.mock.calls[0].arguments, ["out-review", { trigger: "comment", userId: "admin-1" }]);
});

test("messages: an ADMIN note elsewhere is stored without starting a run", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/messages/route");
  as("ADMIN");
  for (const body of [{ body: "Whole-request note" }, { outputId: "out-new", body: "Queued" }, { outputId: "out-done", body: "Thanks" }]) {
    const res = await POST(post("messages", body), ctx());
    assert.equal(res.status, 201);
    assert.equal((await res.json()).started, false);
  }
  assert.equal(appendMessage.mock.callCount(), 3);
  assert.equal(startChangeRequestRun.mock.callCount(), 0);
});

test("messages: empty or over-long bodies → 400; unknown request or output → 404", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/[id]/messages/route");
  as("ADMIN");
  assert.equal((await POST(post("messages", { body: "   " }), ctx())).status, 400);
  assert.equal((await POST(post("messages", { body: "x".repeat(5001) }), ctx())).status, 400);
  assert.equal((await POST(post("messages"), ctx())).status, 400);
  assert.equal((await POST(post("messages", { body: "hi" }), ctx("nope"))).status, 404);
  assert.equal((await POST(post("messages", { outputId: "out-elsewhere", body: "hi" }), ctx())).status, 404);
  assert.equal(appendMessage.mock.callCount(), 0);
});
