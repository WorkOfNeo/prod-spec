// Gates of the change-request inbox routes (package H), driven through the
// REAL route handlers with a mocked session and an in-memory stand-in for the
// Prisma delegates they touch. requests.ts itself stays real, so the create,
// list and limit behaviour under test is the one that ships.
//
// Change requests are ADMIN-only for now. Every route answers 404 while
// CHANGE_REQUESTS_ENABLED is off — before the session is even read — then 401
// without a session, then 403 `Requires role: ADMIN` for every other role, a
// REVIEWER included, before anything is read, counted, split or written. The
// behaviour (validation, trust rules, limits, the form helpers, screenshots)
// is driven as an ADMIN.
//
// requests.ts still knows how a non-admin files (as REQUESTER, with a receipt
// email) and lists (only their own requests), for when filing opens to
// reviewers at the rollout gate. The routes can't reach those paths now, so
// they are exercised on the library directly at the end of this file.
//
// Requires Node's module-mock API:
//   node --experimental-test-module-mocks --import tsx --test "tests/**/*.test.ts"
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

type Role = "ADMIN" | "REVIEWER" | "SUPPLIER" | null;
let sessionState: { session: unknown; role: Role } = { session: null, role: null };
const getSessionWithRole = mock.fn(async () => sessionState);
const as = (role: Exclude<Role, null>, id = `${role.toLowerCase()}-1`) => {
  sessionState = { session: { user: { id, email: `${role.toLowerCase()}@example.com` } }, role };
};
const asAnon = () => {
  sessionState = { session: null, role: null };
};

// ── In-memory delegates ─────────────────────────────────────────────────────
type Row = Record<string, unknown>;
let created: { requests: Row[]; outputs: Row[]; attachments: Row[]; messages: Row[] };
let dbCalls: string[];
const spy = <T>(name: string, impl: (args: Row) => T) =>
  mock.fn(async (args: Row = {}) => {
    dbCalls.push(name);
    return impl(args);
  });

const findManyRequests = spy("changeRequest.findMany", () => [
  {
    id: "cr-1",
    number: 7,
    title: "Polybag sticker · PO-0000",
    status: "NEW",
    source: "REQUESTER",
    poNumber: "PO-0000",
    createdById: "reviewer-1",
    createdAt: new Date("2026-01-02T10:00:00Z"),
    updatedAt: new Date("2026-01-02T10:00:00Z"),
    outputs: [{ id: "out-1", label: "Polybag sticker", status: "NEW" }],
  },
]);
let attachmentRow: Row | null = null;
const STYLES = [
  { id: "style-1", customerId: "cust-1", poNumber: "PO-0000", prodSpecId: "spec-1" },
  { id: "style-2", customerId: "cust-1", poNumber: "PO-0000", prodSpecId: "spec-1" },
  { id: "style-elsewhere", customerId: "cust-2", poNumber: "PO-0001", prodSpecId: "spec-1" },
];

let filedLastHour = 0;
const countRequests = spy("changeRequest.count", () => filedLastHour);

const fakeDb = {
  changeRequest: {
    findMany: findManyRequests,
    count: countRequests,
    create: spy("changeRequest.create", (args) => {
      const row = { id: `cr-${created.requests.length + 1}`, number: 41 + created.requests.length, ...(args.data as Row) };
      created.requests.push(row);
      return { id: row.id, number: row.number };
    }),
  },
  changeRequestOutput: {
    create: spy("changeRequestOutput.create", (args) => {
      const row = { id: `out-${created.outputs.length + 1}`, ...(args.data as Row) };
      created.outputs.push(row);
      return { id: row.id };
    }),
  },
  changeRequestAttachment: {
    createMany: spy("changeRequestAttachment.createMany", (args) => {
      created.attachments.push(...(args.data as Row[]));
      return { count: (args.data as Row[]).length };
    }),
    findFirst: spy("changeRequestAttachment.findFirst", () => attachmentRow),
  },
  changeRequestMessage: {
    create: spy("changeRequestMessage.create", (args) => {
      created.messages.push(args.data as Row);
      return { id: "msg-1" };
    }),
  },
  user: {
    findMany: spy("user.findMany", () => [{ id: "reviewer-1", email: "reviewer@example.com" }]),
  },
  style: {
    groupBy: spy("style.groupBy", () => []),
    // The create path's target check asks by id; the search asks by text.
    findMany: spy("style.findMany", (args) => {
      const ids = ((args.where as Row | undefined)?.id as { in?: string[] } | undefined)?.in;
      if (!ids) return [];
      return STYLES.filter((s) => ids.includes(s.id));
    }),
  },
  prodSpec: {
    findMany: spy("prodSpec.findMany", () => [
      {
        id: "spec-1",
        outputs: [
          { variantKey: "layout:bogus-id", widthMm: 50, heightMm: 60, enabled: true },
          { variantKey: "care-label-02", widthMm: 30, heightMm: 60, enabled: true },
          { variantKey: "layout:disabled-id", widthMm: 50, heightMm: 60, enabled: false },
        ],
      },
    ]),
  },
  customer: { findMany: spy("customer.findMany", () => []) },
  outputLayout: { findMany: spy("outputLayout.findMany", () => []) },
  infoAreaSize: { findMany: spy("infoAreaSize.findMany", () => []) },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
};

const sendRequesterUpdate = mock.fn(async () => null);
const loadStyleRenderContext = mock.fn(async (styleId: string) =>
  styleId === "style-1"
    ? { styleId, outputs: [{ variantKey: "care-label-02", widthMm: 30, heightMm: 60, enabled: true }] }
    : null,
);
const splitRequestByOutput = mock.fn(async () => ({ issues: [], note: "ok" }));
class SplitError extends Error {}

before(() => {
  // The real isAdmin from @/lib/roles stays un-mocked.
  mock.module("@/lib/auth-server", { namedExports: { getSessionWithRole } });
  mock.module("@/lib/db", { namedExports: { db: fakeDb } });
  mock.module("@/lib/change-requests/emails", { namedExports: { sendRequesterUpdate } });
  mock.module("@/lib/styles/active-filter", { namedExports: { activeStylesWhere: async () => ({}) } });
  mock.module("@/lib/styles/render-context", { namedExports: { loadStyleRenderContext } });
  mock.module("@/lib/change-requests/agent/split", { namedExports: { splitRequestByOutput, SplitError } });
});

beforeEach(() => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  created = { requests: [], outputs: [], attachments: [], messages: [] };
  dbCalls = [];
  filedLastHour = 0;
  countRequests.mock.resetCalls();
  attachmentRow = null;
  findManyRequests.mock.resetCalls();
  sendRequesterUpdate.mock.resetCalls();
  splitRequestByOutput.mock.resetCalls();
  loadStyleRenderContext.mock.resetCalls();
  getSessionWithRole.mock.resetCalls();
});

// ── Requests ────────────────────────────────────────────────────────────────
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const validBody = {
  message: "",
  styleId: "style-1",
  outputs: [
    {
      label: "Polybag sticker",
      variantKey: "layout:bogus-id",
      text: "Show the pack quantity under the size.",
      attachments: [{ dataUrl: PNG, fileName: "shot.png" }],
    },
    { label: "Care label", variantKey: "care-label-02", text: "Bigger font." },
  ],
};
const json = (path: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const attachmentCtx = { params: Promise.resolve({ id: "cr-1", attachmentId: "att-1" }) };

async function routes() {
  const list = await import("../src/app/api/admin/change-requests/route");
  const search = await import("../src/app/api/admin/change-requests/search/route");
  const styleOutputs = await import("../src/app/api/admin/change-requests/style-outputs/route");
  const split = await import("../src/app/api/admin/change-requests/split/route");
  const attachment = await import("../src/app/api/admin/change-requests/[id]/attachments/[attachmentId]/route");
  return [
    ["GET list", () => list.GET(json("/api/admin/change-requests", "GET"))],
    ["POST create", () => list.POST(json("/api/admin/change-requests", "POST", validBody))],
    ["GET search", () => search.GET(json("/api/admin/change-requests/search?q=PO-0", "GET"))],
    [
      "GET style-outputs",
      () => styleOutputs.GET(json("/api/admin/change-requests/style-outputs?styleId=style-1", "GET")),
    ],
    [
      "POST split",
      () =>
        split.POST(
          json("/api/admin/change-requests/split", "POST", {
            text: "Hello",
            outputs: [{ variantKey: "care-label-02", label: "Care label" }],
          }),
        ),
    ],
    [
      "GET attachment",
      () => attachment.GET(json("/api/admin/change-requests/cr-1/attachments/att-1", "GET"), attachmentCtx),
    ],
  ] as const;
}

// ── The trio ────────────────────────────────────────────────────────────────

test("flag off: every route is a 404, even for an admin, and nothing is read", async () => {
  delete process.env.CHANGE_REQUESTS_ENABLED;
  as("ADMIN");
  for (const [name, call] of await routes()) {
    const res = await call();
    assert.equal(res.status, 404, name);
  }
  assert.equal(getSessionWithRole.mock.callCount(), 0);
  assert.deepEqual(dbCalls, []);
  assert.equal(splitRequestByOutput.mock.callCount(), 0);
});

test("no session: every route is a 401 and nothing is read or written", async () => {
  asAnon();
  for (const [name, call] of await routes()) {
    const res = await call();
    assert.equal(res.status, 401, name);
  }
  assert.deepEqual(dbCalls, []);
  assert.equal(splitRequestByOutput.mock.callCount(), 0);
});

test("any role but ADMIN — a REVIEWER included: every route is a 403 and nothing is read, counted, split or written", async () => {
  for (const role of ["REVIEWER", "SUPPLIER"] as const) {
    as(role);
    for (const [name, call] of await routes()) {
      const res = await call();
      assert.equal(res.status, 403, `${role} ${name}`);
      assert.deepEqual(await res.json(), { error: "Requires role: ADMIN" }, `${role} ${name}`);
    }
  }
  assert.deepEqual(dbCalls, []);
  assert.equal(created.requests.length, 0);
  assert.equal(splitRequestByOutput.mock.callCount(), 0);
  assert.equal(loadStyleRenderContext.mock.callCount(), 0);
  assert.equal(sendRequesterUpdate.mock.callCount(), 0);
});

// ── Listing ─────────────────────────────────────────────────────────────────

test("GET list: a REVIEWER gets 403 and nothing is read; an admin sees all, status filter applied", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/route");
  as("REVIEWER");
  const refused = await GET(json("/api/admin/change-requests?status=NEW", "GET"));
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "Requires role: ADMIN" });
  assert.equal(findManyRequests.mock.callCount(), 0);
  assert.deepEqual(dbCalls, []);

  as("ADMIN");
  const res = await GET(json("/api/admin/change-requests?status=NEW", "GET"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  // Not scoped to the admin: only the status narrows the list.
  const where = (findManyRequests.mock.calls[0].arguments[0] as { where: Row }).where;
  assert.deepEqual(where, { status: "NEW" });
  // A request someone else filed is in the admin's inbox, with its filer.
  const body = (await res.json()) as { requests: Array<{ ref: string; createdByEmail: string }> };
  assert.equal(body.requests[0].ref, "R-0007");
  assert.equal(body.requests[0].createdByEmail, "reviewer@example.com");

  await GET(json("/api/admin/change-requests", "GET"));
  assert.deepEqual((findManyRequests.mock.calls[1].arguments[0] as { where: Row }).where, {});
});

test("GET list: an unknown status is a 400", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/route");
  as("ADMIN");
  const res = await GET(json("/api/admin/change-requests?status=BOGUS", "GET"));
  assert.equal(res.status, 400);
  assert.equal(findManyRequests.mock.callCount(), 0);
});

test("POST: a REVIEWER gets 403 and nothing is read, counted or written, and no receipt goes out", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/route");
  as("REVIEWER");
  const res = await POST(json("/api/admin/change-requests", "POST", validBody));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Requires role: ADMIN" });
  assert.equal(countRequests.mock.callCount(), 0, "the hourly limit isn't even counted");
  assert.deepEqual(dbCalls, []);
  assert.deepEqual(created, { requests: [], outputs: [], attachments: [], messages: [] });
  assert.equal(sendRequesterUpdate.mock.callCount(), 0);
});

test("POST: an admin files as ADMIN, in one go, and no receipt email goes out", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/route");
  as("ADMIN");
  const res = await POST(json("/api/admin/change-requests", "POST", validBody));
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { id: "cr-1", number: 41 });

  const [request] = created.requests;
  assert.equal(request.source, "ADMIN");
  assert.equal(request.status, "NEW");
  assert.equal(request.createdById, "admin-1");
  // The picked style filled in the customer and PO; the title is derived.
  assert.equal(request.customerId, "cust-1");
  assert.equal(request.poNumber, "PO-0000");
  assert.equal(request.title, "Polybag sticker +1 · PO-0000");
  // Nothing pasted → the issues are the message.
  assert.match(String(request.message), /^Polybag sticker:\nShow the pack quantity/);

  assert.deepEqual(
    created.outputs.map((o) => [o.position, o.label, o.layoutId, o.styleId, o.status]),
    [
      [0, "Polybag sticker", "bogus-id", "style-1", "NEW"],
      [1, "Care label", null, "style-1", "NEW"],
    ],
  );
  assert.equal(created.attachments.length, 1);
  assert.equal(created.attachments[0].outputId, "out-1");
  assert.equal(created.attachments[0].mimeType, "image/png");
  assert.equal(created.attachments[0].uploadedById, "admin-1");

  assert.deepEqual(
    created.messages.map((m) => [m.authorKind, m.body]),
    [["SYSTEM", "Request received"]],
  );
  // The receipt email is for a REQUESTER; an admin filing gets none.
  assert.equal(sendRequesterUpdate.mock.callCount(), 0);
});

test("POST: an admin may set the title, and still no receipt goes out", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/route");
  as("ADMIN");
  const res = await POST(json("/api/admin/change-requests", "POST", { ...validBody, title: "Custom title" }));
  assert.equal(res.status, 201);
  assert.equal(created.requests[0].source, "ADMIN");
  assert.equal(created.requests[0].title, "Custom title");
  assert.equal(sendRequesterUpdate.mock.callCount(), 0);
});

test("POST: a bad body or a bad screenshot is a 400 with nothing written", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/route");
  as("ADMIN");
  const noOutputs = await POST(json("/api/admin/change-requests", "POST", { message: "x", outputs: [] }));
  assert.equal(noOutputs.status, 400);

  const svg = await POST(
    json("/api/admin/change-requests", "POST", {
      ...validBody,
      outputs: [{ ...validBody.outputs[0], attachments: [{ dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }] }],
    }),
  );
  assert.equal(svg.status, 400);

  const goneStyle = await POST(json("/api/admin/change-requests", "POST", { ...validBody, styleId: "style-gone" }));
  assert.equal(goneStyle.status, 400);

  assert.equal(created.requests.length, 0);
  assert.equal(created.outputs.length, 0);
  assert.equal(created.attachments.length, 0);
});

test("POST: the client can't name the layout, the customer, the order or a foreign style", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/route");
  as("ADMIN");
  const res = await POST(
    json("/api/admin/change-requests", "POST", {
      ...validBody,
      customerId: "cust-evil",
      poNumber: "PO-9999",
      outputs: [{ ...validBody.outputs[0], layoutId: "someone-elses-layout", styleId: "style-2" }],
    }),
  );
  assert.equal(res.status, 201);
  assert.equal(created.requests[0].customerId, "cust-1");
  assert.equal(created.requests[0].poNumber, "PO-0000");
  assert.deepEqual(
    created.outputs.map((o) => [o.variantKey, o.layoutId, o.styleId]),
    [["layout:bogus-id", "bogus-id", "style-2"]],
  );
});

test("POST: an output the style doesn't print (or has disabled), or a style of another order, is a 400 with nothing written", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/route");
  as("ADMIN");
  for (const out of [
    { ...validBody.outputs[1], variantKey: "layout:someone-elses-layout" },
    { ...validBody.outputs[1], variantKey: "layout:disabled-id" },
    { ...validBody.outputs[1], styleId: "style-elsewhere" },
  ]) {
    const res = await POST(json("/api/admin/change-requests", "POST", { ...validBody, outputs: [out] }));
    assert.equal(res.status, 400, JSON.stringify(out));
  }
  assert.equal(created.requests.length, 0);
  assert.equal(created.outputs.length, 0);
});

// ── Limits ──────────────────────────────────────────────────────────────────

test("POST: a body declared over 60 MB is a 413 before anything is read or counted", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/route");
  as("ADMIN");
  const req = new NextRequest("http://localhost/api/admin/change-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": String(60 * 1024 * 1024 + 1) },
    body: JSON.stringify(validBody),
  });
  const res = await POST(req);
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too large/);
  assert.deepEqual(dbCalls, []);
});

test("POST: a body without a length is counted as it streams and cut off past 60 MB", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/route");
  as("ADMIN");
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Never ends on its own: only the cap stops the read.
      sent++;
      controller.enqueue(chunk);
    },
  });
  const req = new NextRequest("http://localhost/api/admin/change-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1]);
  const res = await POST(req);
  assert.equal(res.status, 413);
  assert.ok(sent <= 62, `read ${sent} MB`);
  assert.equal(created.requests.length, 0);
});

test("POST: 20 requests in the last hour is the limit — the 21st is a 429, admins included", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/route");
  as("ADMIN");
  filedLastHour = 20;
  const res = await POST(json("/api/admin/change-requests", "POST", validBody));
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /20 requests in the last hour/);
  // Counted per person (the admin's own filings), over a rolling hour.
  const where = (countRequests.mock.calls[0].arguments[0] as { where: Row }).where;
  assert.equal(where.createdById, "admin-1");
  const since = (where.createdAt as { gte: Date }).gte;
  assert.ok(Math.abs(Date.now() - 60 * 60 * 1000 - since.getTime()) < 5_000, "a rolling hour");
  assert.equal(created.requests.length, 0);

  filedLastHour = 19;
  assert.equal((await POST(json("/api/admin/change-requests", "POST", validBody))).status, 201);
});

// ── Attachments ─────────────────────────────────────────────────────────────

test("attachment: a REVIEWER gets 403 — even the request's creator — and nothing is read; an admin gets the bytes", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/[id]/attachments/[attachmentId]/route");
  const req = json("/api/admin/change-requests/cr-1/attachments/att-1", "GET");
  attachmentRow = { data: Buffer.from([1, 2, 3]), mimeType: "image/png", request: { createdById: "reviewer-1" } };

  for (const id of ["reviewer-2", "reviewer-1"]) {
    as("REVIEWER", id);
    const refused = await GET(req, attachmentCtx);
    assert.equal(refused.status, 403, id);
    assert.deepEqual(await refused.json(), { error: "Requires role: ADMIN" }, id);
  }
  assert.deepEqual(dbCalls, [], "the attachment row is never read for a reviewer");

  as("ADMIN");
  const res = await GET(req, attachmentCtx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/png");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual(dbCalls, ["changeRequestAttachment.findFirst"]);

  attachmentRow = null;
  assert.equal((await GET(req, attachmentCtx)).status, 404);
});

// ── Form helpers ────────────────────────────────────────────────────────────

test("split: a REVIEWER gets 403 and nothing is split; an admin splits; a SplitError is a 502 the form can show", async () => {
  const { POST } = await import("../src/app/api/admin/change-requests/split/route");
  const body = { text: "Hello", outputs: [{ variantKey: "care-label-02", label: "Care label" }] };
  as("REVIEWER");
  const refused = await POST(json("/api/admin/change-requests/split", "POST", body));
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "Requires role: ADMIN" });
  assert.equal(splitRequestByOutput.mock.callCount(), 0);

  as("ADMIN");
  const ok = await POST(json("/api/admin/change-requests/split", "POST", body));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { issues: [], note: "ok" });

  splitRequestByOutput.mock.mockImplementationOnce(async () => {
    throw new SplitError("The AI is busy");
  });
  const failed = await POST(json("/api/admin/change-requests/split", "POST", body));
  assert.equal(failed.status, 502);
  assert.deepEqual(await failed.json(), { error: "The AI is busy" });

  const empty = await POST(json("/api/admin/change-requests/split", "POST", { ...body, outputs: [] }));
  assert.equal(empty.status, 400);
});

test("style-outputs: styleId is required; an unknown style is a 404", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/style-outputs/route");
  as("ADMIN");
  assert.equal((await GET(json("/api/admin/change-requests/style-outputs", "GET"))).status, 400);
  assert.equal((await GET(json("/api/admin/change-requests/style-outputs?styleId=nope", "GET"))).status, 404);
  const res = await GET(json("/api/admin/change-requests/style-outputs?styleId=style-1", "GET"));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { outputs: Array<{ variantKey: string; widthMm: number; isLayout: boolean }> };
  assert.equal(body.outputs[0].variantKey, "care-label-02");
  assert.equal(body.outputs[0].widthMm, 30);
  assert.equal(body.outputs[0].isLayout, false);
});

test("search: a one-letter query answers empty without touching the database", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/search/route");
  as("ADMIN");
  const res = await GET(json("/api/admin/change-requests/search?q=P", "GET"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { pos: [], styles: [] });
  assert.deepEqual(dbCalls, []);
});

// ── Kept for when filing opens to reviewers ─────────────────────────────────
// The routes refuse every non-admin first, so these requests.ts paths are
// unreachable over HTTP for now; they are driven on the library directly so
// they keep working for the rollout gate.

test("listChangeRequests: a non-admin viewer is still scoped to their own requests; an admin to none", async () => {
  const { listChangeRequests } = await import("../src/lib/change-requests/requests");
  const rows = await listChangeRequests({ viewer: { userId: "reviewer-1", role: "REVIEWER" }, status: "NEW" });
  assert.deepEqual((findManyRequests.mock.calls[0].arguments[0] as { where: Row }).where, {
    createdById: "reviewer-1",
    status: "NEW",
  });
  assert.equal(rows[0].ref, "R-0007");
  assert.equal(rows[0].createdByEmail, "reviewer@example.com");

  await listChangeRequests({ viewer: { userId: "admin-1", role: "ADMIN" } });
  assert.deepEqual((findManyRequests.mock.calls[1].arguments[0] as { where: Row }).where, {});
});

test("createChangeRequest: a non-admin still files as REQUESTER and is emailed a receipt", async () => {
  const { createChangeRequest, CreateChangeRequestSchema } = await import("../src/lib/change-requests/requests");
  const input = CreateChangeRequestSchema.parse(validBody);
  assert.deepEqual(await createChangeRequest(input, { userId: "reviewer-1", role: "REVIEWER" }), { id: "cr-1", number: 41 });

  const [request] = created.requests;
  assert.equal(request.source, "REQUESTER");
  assert.equal(request.status, "NEW");
  assert.equal(request.createdById, "reviewer-1");
  assert.equal(created.attachments[0].uploadedById, "reviewer-1");
  assert.deepEqual(
    created.messages.map((m) => [m.authorKind, m.body]),
    [["SYSTEM", "Request received"]],
  );
  assert.equal(sendRequesterUpdate.mock.callCount(), 1);
  assert.deepEqual(sendRequesterUpdate.mock.calls[0].arguments, ["cr-1", "received"]);
});
