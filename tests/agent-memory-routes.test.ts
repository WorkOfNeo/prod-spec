// Agent memory: the two /api/admin/agent-memory routes driven through their
// REAL handlers with a mocked session, over an in-memory agent_memories table,
// so the gate, the body validation and memory.ts's DB orchestration are
// exercised together without a database:
//
//   • the flag is a hard off switch: 404 before auth, nothing read or written;
//   • ADMIN only (401 anonymous, 403 reviewer) — a kept note steers every
//     later agent run, so a reviewer must not be able to keep or reword one;
//   • PATCH validates its body and refuses illegal moves (409), unknown ids
//     (404), and a state that changed between read and write (409);
//   • memoriesForPrompt hands the agent only KEPT notes for its scopes and
//     stamps their use; reads degrade to empty while the table is missing.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// ── Session ─────────────────────────────────────────────────────────────────
type Role = "ADMIN" | "REVIEWER" | null;
let sessionState: { session: unknown; role: Role } = { session: null, role: null };
const as = (role: Exclude<Role, null>) => {
  sessionState = { session: { user: { id: `${role}-1`, email: `${role.toLowerCase()}@example.com` } }, role };
};
const asAnon = () => {
  sessionState = { session: null, role: null };
};

// ── In-memory tables ────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
let memories: Row[] = [];
let requests: Row[] = [];
let customers: Row[] = [];
let reads = 0;
let writes = 0;
let tableMissing = false;
// Runs once, just before the next updateMany (another admin's click).
let beforeUpdate: (() => void) | null = null;

const prismaError = (code: string, message: string) => Object.assign(new Error(message), { code });
const guard = () => {
  if (tableMissing) throw prismaError("P2021", "The table `agent_memories` does not exist");
};

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Row[]).some((w) => matches(row, w));
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Row;
      if ("in" in c) return (c.in as unknown[]).includes(row[key]);
    }
    return row[key] === cond;
  });
}

function pick(row: Row, select?: Row): Row {
  if (!select) return structuredClone(row);
  return Object.fromEntries(Object.keys(select).map((k) => [k, structuredClone(row[k])]));
}

function sortBy(rows: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return rows;
  const [key, dir] = Object.entries(orderBy)[0] as [string, "asc" | "desc"];
  const sign = dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => sign * ((a[key] as Date).getTime() - (b[key] as Date).getTime()));
}

const fakeDb = {
  agentMemory: {
    findMany: async (args: { where?: Row; orderBy?: Row; take?: number; select?: Row } = {}) => {
      reads++;
      guard();
      const rows = sortBy(
        memories.filter((r) => matches(r, args.where)),
        args.orderBy,
      );
      return rows.slice(0, args.take ?? rows.length).map((r) => pick(r, args.select));
    },
    findUnique: async (args: { where: { id: string } }) => {
      reads++;
      guard();
      const row = memories.find((r) => r.id === args.where.id);
      return row ? structuredClone(row) : null;
    },
    create: async (args: { data: Row }) => {
      guard();
      writes++;
      const at = new Date(Date.UTC(2026, 9, 24, 9, ++seq));
      const row: Row = {
        id: `mem-${seq}`,
        scopeRef: null,
        sourceRequestId: null,
        usedCount: 0,
        lastUsedAt: null,
        createdById: null,
        createdAt: at,
        updatedAt: at,
        ...args.data,
      };
      memories.push(row);
      return structuredClone(row);
    },
    updateMany: async (args: { where: Row; data: Row }) => {
      guard();
      if (beforeUpdate) {
        const hook = beforeUpdate;
        beforeUpdate = null;
        hook();
      }
      writes++;
      const rows = memories.filter((r) => matches(r, args.where));
      for (const r of rows) {
        for (const [k, v] of Object.entries(args.data)) {
          if (v && typeof v === "object" && "increment" in (v as Row)) {
            r[k] = (r[k] as number) + ((v as Row).increment as number);
          } else {
            r[k] = v instanceof Date ? new Date(v) : v;
          }
        }
        // Prisma's @updatedAt: set on every update unless given explicitly.
        if (!("updatedAt" in args.data)) r.updatedAt = new Date(Date.now() + 1000);
      }
      return { count: rows.length };
    },
  },
  changeRequest: {
    findMany: async (args: { where?: Row; select?: Row }) =>
      requests.filter((r) => matches(r, args.where)).map((r) => pick(r, args.select)),
  },
  customer: {
    findMany: async (args: { where?: Row; select?: Row }) =>
      customers.filter((r) => matches(r, args.where)).map((r) => pick(r, args.select)),
    findUnique: async (args: { where: { id: string }; select?: Row }) => {
      const row = customers.find((r) => r.id === args.where.id);
      return row ? pick(row, args.select) : null;
    },
  },
};

let seq = 0;
function seed(over: Row): Row {
  const at = new Date(Date.UTC(2026, 9, 24, 8, seq));
  const row: Row = {
    id: `mem-${++seq}`,
    scope: "GLOBAL",
    scopeRef: null,
    text: "A note",
    state: "PROPOSED",
    sourceKind: "CORRECTION",
    sourceRequestId: null,
    usedCount: 0,
    lastUsedAt: null,
    createdById: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
  memories.push(row);
  return row;
}

before(() => {
  mock.module("@/lib/auth-server", { namedExports: { getSessionWithRole: async () => sessionState } });
  mock.module("@/lib/db", { namedExports: { db: fakeDb } });
});

const prevFlag = process.env.CHANGE_REQUESTS_ENABLED;
beforeEach(() => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  memories = [];
  requests = [{ id: "req-1", number: 1 }];
  customers = [{ id: "cust-1", name: "Example Retail" }];
  reads = 0;
  writes = 0;
  tableMissing = false;
  beforeUpdate = null;
  seq = 0;
  as("ADMIN");
});
after(() => {
  if (prevFlag === undefined) delete process.env.CHANGE_REQUESTS_ENABLED;
  else process.env.CHANGE_REQUESTS_ENABLED = prevFlag;
});

const listReq = (qs = "") => new NextRequest(`http://localhost/api/admin/agent-memory${qs}`);
const patchReq = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/agent-memory/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const postReq = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/agent-memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// ── Gate ────────────────────────────────────────────────────────────────────

test("flag off: both routes 404 for everyone, before auth, touching nothing", async () => {
  const { GET } = await import("../src/app/api/admin/agent-memory/route");
  const { PATCH } = await import("../src/app/api/admin/agent-memory/[id]/route");
  const m = seed({});
  delete process.env.CHANGE_REQUESTS_ENABLED;
  for (const who of [asAnon, () => as("ADMIN")]) {
    who();
    assert.equal((await GET(listReq())).status, 404);
    assert.equal((await PATCH(patchReq({ state: "KEPT" }), params(m.id as string))).status, 404);
  }
  process.env.CHANGE_REQUESTS_ENABLED = "false";
  assert.equal((await GET(listReq())).status, 404);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(m.state, "PROPOSED");
});

test("GET: anonymous 401, reviewer 403, and the table is never read", async () => {
  const { GET } = await import("../src/app/api/admin/agent-memory/route");
  asAnon();
  assert.equal((await GET(listReq())).status, 401);
  as("REVIEWER");
  assert.equal((await GET(listReq())).status, 403);
  assert.equal(reads, 0);
});

test("PATCH: anonymous 401, reviewer 403, and nothing is written", async () => {
  const { PATCH } = await import("../src/app/api/admin/agent-memory/[id]/route");
  const m = seed({});
  asAnon();
  assert.equal((await PATCH(patchReq({ state: "KEPT" }), params(m.id as string))).status, 401);
  as("REVIEWER");
  assert.equal((await PATCH(patchReq({ state: "KEPT" }), params(m.id as string))).status, 403);
  assert.equal(writes, 0);
  assert.equal(m.state, "PROPOSED");
});

// ── GET ─────────────────────────────────────────────────────────────────────

test("GET: lists notes newest first with scope and source labels", async () => {
  const { GET } = await import("../src/app/api/admin/agent-memory/route");
  seed({ text: "older", scope: "CUSTOMER", scopeRef: "cust-1", sourceRequestId: "req-1" });
  seed({ text: "newer", scope: "DOC_TYPE", scopeRef: "WASHCARE", sourceKind: "AGENT_FINDING" });
  const res = await GET(listReq());
  assert.equal(res.status, 200);
  const { memories: list } = (await res.json()) as { memories: Row[] };
  assert.deepEqual(
    list.map((m) => [m.text, m.scopeLabel, m.sourceLabel, m.requestNumber]),
    [
      ["newer", "Doc type · Wash care", "the agent noticed", null],
      ["older", "Customer · Example Retail", "R-0001 · your correction", 1],
    ],
  );
});

test("GET: filters by scope and state; unknown values are a 400", async () => {
  const { GET } = await import("../src/app/api/admin/agent-memory/route");
  seed({ scope: "GLOBAL", state: "KEPT" });
  seed({ scope: "GLOBAL", state: "PROPOSED" });
  seed({ scope: "MONDAY", state: "KEPT" });
  const scoped = (await (await GET(listReq("?scope=GLOBAL"))).json()) as { memories: Row[] };
  assert.equal(scoped.memories.length, 2);
  const both = (await (await GET(listReq("?scope=GLOBAL&state=KEPT"))).json()) as { memories: Row[] };
  assert.equal(both.memories.length, 1);
  assert.equal((await GET(listReq("?scope=EVERYWHERE"))).status, 400);
  assert.equal((await GET(listReq("?state=DELETED"))).status, 400);
  // An empty param is "no filter", as a cleared chip would send it.
  const all = (await (await GET(listReq("?scope="))).json()) as { memories: Row[] };
  assert.equal(all.memories.length, 3);
});

test("GET: a missing table reads as no notes, not a 500", async () => {
  const { GET } = await import("../src/app/api/admin/agent-memory/route");
  tableMissing = true;
  const res = await GET(listReq());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { memories: [] });
});

// ── PATCH validation ────────────────────────────────────────────────────────

test("PATCH: malformed bodies are a 400 and write nothing", async () => {
  const { PATCH } = await import("../src/app/api/admin/agent-memory/[id]/route");
  const m = seed({ state: "KEPT" });
  const id = m.id as string;
  const bad: unknown[] = [
    "{not json",
    {},
    { state: "DELETED" },
    { state: "kept" },
    { text: 42 },
    { text: "   " },
    { text: "a".repeat(1001) },
    { state: "KEPT", scope: "GLOBAL" }, // only state and text can change here
    [],
    null,
  ];
  for (const body of bad) {
    const res = await PATCH(patchReq(body), params(id));
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal(writes, 0);
  assert.equal(m.text, "A note");
});

test("PATCH: an unknown id is a 404", async () => {
  const { PATCH } = await import("../src/app/api/admin/agent-memory/[id]/route");
  const res = await PATCH(patchReq({ state: "KEPT" }), params("bogus-id"));
  assert.equal(res.status, 404);
});

test("PATCH: illegal moves and edits of closed notes are a 409 with a reason", async () => {
  const { PATCH } = await import("../src/app/api/admin/agent-memory/[id]/route");
  const kept = seed({ state: "KEPT" });
  const res = await PATCH(patchReq({ state: "DISMISSED" }), params(kept.id as string));
  assert.equal(res.status, 409);
  const body = (await res.json()) as { error: string; code: string };
  assert.equal(body.code, "invalid_transition");
  assert.match(body.error, /kept note can't become dismissed/);

  const forgotten = seed({ state: "FORGOTTEN" });
  const edit = await PATCH(patchReq({ text: "new words" }), params(forgotten.id as string));
  assert.equal(edit.status, 409);
  assert.equal(((await edit.json()) as { code: string }).code, "not_editable");
  assert.equal(writes, 0);
});

// ── PATCH lifecycle ─────────────────────────────────────────────────────────

test("PATCH: keep → forget → restore, and reword a kept note", async () => {
  const { PATCH } = await import("../src/app/api/admin/agent-memory/[id]/route");
  const m = seed({ state: "PROPOSED", text: "Quantities in bold" });
  const id = m.id as string;
  const step = async (body: Row) => {
    const res = await PATCH(patchReq(body), params(id));
    assert.equal(res.status, 200, JSON.stringify(body));
    return ((await res.json()) as { memory: Row }).memory;
  };
  assert.equal((await step({ state: "KEPT" })).state, "KEPT");
  assert.equal((await step({ text: "  Quantities in bold, 7 pt  " })).text, "Quantities in bold, 7 pt");
  assert.equal((await step({ state: "FORGOTTEN" })).state, "FORGOTTEN");
  assert.equal((await step({ state: "KEPT" })).state, "KEPT");
  // Repeating the same state is a harmless no-op.
  const before = writes;
  assert.equal((await step({ state: "KEPT" })).state, "KEPT");
  assert.equal(writes, before);
});

test("PATCH: dismiss, then restore back to a suggestion; reword and keep in one call", async () => {
  const { PATCH } = await import("../src/app/api/admin/agent-memory/[id]/route");
  const m = seed({ state: "PROPOSED" });
  const id = m.id as string;
  assert.equal((await PATCH(patchReq({ state: "DISMISSED" }), params(id))).status, 200);
  assert.equal((await PATCH(patchReq({ state: "PROPOSED" }), params(id))).status, 200);
  const res = await PATCH(patchReq({ state: "KEPT", text: "Reworded" }), params(id));
  assert.equal(res.status, 200);
  assert.equal(m.state, "KEPT");
  assert.equal(m.text, "Reworded");
});

test("PATCH: a note whose state changed between read and write is a 409, not a lost update", async () => {
  const { PATCH } = await import("../src/app/api/admin/agent-memory/[id]/route");
  const m = seed({ state: "PROPOSED" });
  // Another admin dismisses it just before our Keep lands.
  beforeUpdate = () => {
    m.state = "DISMISSED";
  };
  const res = await PATCH(patchReq({ state: "KEPT" }), params(m.id as string));
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, "conflict");
  assert.equal(m.state, "DISMISSED");
});

// ── memoriesForPrompt + memoryLog ───────────────────────────────────────────

test("memoriesForPrompt: only KEPT notes for global, this customer, this doc type and Monday", async () => {
  const { memoriesForPrompt } = await import("../src/lib/change-requests/memory");
  const g = seed({ state: "KEPT", scope: "GLOBAL", text: "Never below 5 pt." });
  const c = seed({ state: "KEPT", scope: "CUSTOMER", scopeRef: "cust-1", text: "Quantities in bold." });
  seed({ state: "KEPT", scope: "CUSTOMER", scopeRef: "cust-2", text: "Someone else's rule." });
  const d = seed({ state: "KEPT", scope: "DOC_TYPE", scopeRef: "STICKER", text: "Sticker rule." });
  seed({ state: "KEPT", scope: "DOC_TYPE", scopeRef: "WASHCARE", text: "Wash care rule." });
  const mo = seed({ state: "KEPT", scope: "MONDAY", text: "Sizes can be ranges." });
  seed({ state: "PROPOSED", scope: "GLOBAL", text: "Not kept yet." });
  seed({ state: "FORGOTTEN", scope: "GLOBAL", text: "Forgotten." });
  seed({ state: "DISMISSED", scope: "GLOBAL", text: "Dismissed." });

  const { text, ids } = await memoriesForPrompt({ customerId: "cust-1", docType: "STICKER" });
  assert.deepEqual(ids, [g.id, c.id, d.id, mo.id]);
  assert.equal(
    text,
    [
      "## Notes: general",
      "- Never below 5 pt.",
      "",
      "## Notes: this customer",
      "- Quantities in bold.",
      "",
      "## Notes: this document type",
      "- Sticker rule.",
      "",
      "## Notes: Monday data",
      "- Sizes can be ranges.",
    ].join("\n"),
  );
  for (const row of [g, c, d, mo]) {
    assert.equal(row.usedCount, 1);
    assert.ok(row.lastUsedAt instanceof Date);
    assert.equal((row.lastUsedAt as Date).getTime(), (row.updatedAt as Date).getTime());
  }
  const untouched = memories.filter((r) => !ids.includes(r.id as string));
  assert.ok(untouched.every((r) => r.usedCount === 0 && r.lastUsedAt === null));
});

test("memoriesForPrompt: without a customer or doc type only global and Monday notes apply", async () => {
  const { memoriesForPrompt } = await import("../src/lib/change-requests/memory");
  const g = seed({ state: "KEPT", scope: "GLOBAL" });
  seed({ state: "KEPT", scope: "CUSTOMER", scopeRef: "cust-1" });
  seed({ state: "KEPT", scope: "DOC_TYPE", scopeRef: "STICKER" });
  const { ids } = await memoriesForPrompt();
  assert.deepEqual(ids, [g.id]);
});

test("memoriesForPrompt: nothing kept, or no table yet → empty text, no writes", async () => {
  const { memoriesForPrompt } = await import("../src/lib/change-requests/memory");
  seed({ state: "PROPOSED" });
  assert.deepEqual(await memoriesForPrompt({ customerId: "cust-1" }), { text: "", ids: [] });
  tableMissing = true;
  assert.deepEqual(await memoriesForPrompt({ customerId: "cust-1" }), { text: "", ids: [] });
  assert.equal(writes, 0);
});

test("memoryLog: newest first, a prompt read shows as 'Read by the agent'", async () => {
  const { memoriesForPrompt, memoryLog, setMemoryState } = await import("../src/lib/change-requests/memory");
  const used = seed({ state: "KEPT", text: "used one", sourceRequestId: "req-1" });
  const dismissed = seed({ state: "PROPOSED", text: "dismissed one" });
  await memoriesForPrompt();
  await setMemoryState(dismissed.id as string, "DISMISSED");
  const log = await memoryLog(10);
  assert.deepEqual(
    log.map((e) => [e.text, e.label, e.source]),
    [
      ["dismissed one", "Dismissed", "your correction"],
      ["used one", "Read by the agent", "R-0001 · your correction"],
    ],
  );
  assert.ok(log[0].when.getTime() >= (used.updatedAt as Date).getTime());
  tableMissing = true;
  assert.deepEqual(await memoryLog(), []);
});

// ── POST: a note written by hand ────────────────────────────────────────────

test("POST: flag off 404, anonymous 401, reviewer 403, and nothing is written", async () => {
  const { POST } = await import("../src/app/api/admin/agent-memory/route");
  const body = { scope: "MONDAY", text: "Certificates drive the cert marks." };
  delete process.env.CHANGE_REQUESTS_ENABLED;
  assert.equal((await POST(postReq(body))).status, 404);
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  asAnon();
  assert.equal((await POST(postReq(body))).status, 401);
  as("REVIEWER");
  assert.equal((await POST(postReq(body))).status, 403);
  assert.equal(writes, 0);
  assert.equal(memories.length, 0);
});

test("POST: a hand-written note is KEPT at once, MANUAL, by its author — and the next run reads it", async () => {
  const { POST } = await import("../src/app/api/admin/agent-memory/route");
  const res = await POST(postReq({ scope: "MONDAY", scopeRef: "dropped", text: "  Certificates drive the cert marks. " }));
  assert.equal(res.status, 201);
  const { memory } = (await res.json()) as { memory: Row };
  assert.equal(memory.state, "KEPT");
  assert.equal(memory.sourceKind, "MANUAL");
  assert.equal(memory.scopeRef, null);
  assert.equal(memory.text, "Certificates drive the cert marks.");
  assert.equal(memory.createdById, "ADMIN-1");

  const { memoriesForPrompt } = await import("../src/lib/change-requests/memory");
  const prompt = await memoriesForPrompt({});
  assert.match(prompt.text, /## Notes: Monday data\n- Certificates drive the cert marks\./);
});

test("POST: a customer note names a customer that exists; bad bodies are a 400 that write nothing", async () => {
  const { POST } = await import("../src/app/api/admin/agent-memory/route");
  const ok = await POST(postReq({ scope: "CUSTOMER", scopeRef: "cust-1", text: "Quantities in bold." }));
  assert.equal(ok.status, 201);
  assert.equal(((await ok.json()) as { memory: Row }).memory.scopeRef, "cust-1");
  const before = memories.length;

  for (const body of [
    { scope: "CUSTOMER", scopeRef: "cust-gone", text: "x" },
    { scope: "CUSTOMER", text: "x" },
    { scope: "DOC_TYPE", text: "x" },
    { scope: "SOMEWHERE", text: "x" },
    { scope: "GLOBAL", text: "   " },
    { scope: "GLOBAL", text: "x", state: "KEPT" },
    "not json",
  ]) {
    const res = await POST(postReq(body));
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(memories.length, before);
});
