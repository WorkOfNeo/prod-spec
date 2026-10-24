// Layout revision routes (design §5.1, §6): the HTTP edge over revisions.ts.
// Drives each REAL route handler with a mocked session and a mocked
// revisions.ts (spies + the four typed errors), so what's pinned here is the
// route's own job:
//
//   • the gate — 404 for everyone while CHANGE_REQUESTS_ENABLED is off, then
//     401 without a session, 403 for a REVIEWER, and nothing reached before it;
//   • the error mapping — not found 404, state 409, conflict 409 WITH what
//     moved, validation 422 WITH the gate's details;
//   • the happy paths call the right revisions.ts function with the admin as
//     the user, and never hand back the definition blobs where a summary will do.
//
// Plus the Output Builder's own publish route: it records a history row after
// a successful publish, and a failing history write never fails the publish.
// The DB behaviour of revisions.ts itself is pinned in
// tests/output-layout-revisions.test.ts.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// ── Session ─────────────────────────────────────────────────────────────────
type Role = "ADMIN" | "REVIEWER" | null;
let sessionState: { session: unknown; role: Role } = { session: null, role: null };
function asAdmin() {
  sessionState = { session: { user: { id: "admin-1", email: "admin@example.com" } }, role: "ADMIN" };
}
function asReviewer() {
  sessionState = { session: { user: { id: "rev-1", email: "reviewer@example.com" } }, role: "REVIEWER" };
}
function asAnon() {
  sessionState = { session: null, role: null };
}

// ── The typed errors (mirrors of revisions.ts; the routes see these) ────────
type Conflict = { baseVersion: number; liveVersion: number; versionChanged: boolean; definitionChanged: boolean };
class RevisionNotFoundError extends Error {
  readonly httpStatus = 404;
  constructor(
    readonly what: "revision" | "layout",
    readonly id: string,
  ) {
    super(what === "layout" ? "Layout not found" : "Revision not found");
  }
}
class RevisionStateError extends Error {
  readonly httpStatus = 409;
  constructor(
    readonly revisionId: string,
    readonly status: string,
    message: string,
  ) {
    super(message);
  }
}
class RevisionConflictError extends Error {
  readonly httpStatus = 409;
  constructor(readonly conflict: Conflict) {
    super("Can't publish: the layout was edited in the Output Builder since this draft was made.");
  }
}
class RevisionValidationError extends Error {
  readonly httpStatus = 422;
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(message);
  }
}

// ── Fixtures (synthetic 50×60 mm sticker) ───────────────────────────────────
function def(lines: string[]) {
  return {
    pages: [
      {
        id: "p1",
        widthMm: 50,
        heightMm: 60,
        gridCols: 12,
        gridRows: 15,
        blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 2 }, lines }],
      },
    ],
  };
}
const LIVE = def(["{{styleNumber}}"]);
const PROPOSED = def(["{{styleNumber}}", '{{if polybagQty != ""}}{{polybagQty}} PCS{{endif}}']);

function revisionRow(over: Record<string, unknown> = {}) {
  return {
    id: "bogus-rev",
    layoutId: "bogus-layout",
    number: 3,
    status: "DRAFT",
    definition: PROPOSED,
    baseDefinition: LIVE,
    baseVersion: 1,
    authorKind: "USER",
    authorUserId: "admin-1",
    changeRequestOutputId: null,
    parentRevisionId: null,
    ops: null,
    note: null,
    publishedAt: null,
    publishedById: null,
    publishedVersion: null,
    createdAt: new Date(0),
    ...over,
  };
}
function publishResult(over: Record<string, unknown> = {}) {
  return {
    revision: revisionRow({ status: "PUBLISHED", publishedVersion: 2, publishedById: "admin-1" }),
    layout: { id: "bogus-layout", status: "PUBLISHED", version: 2 },
    publishedVersion: 2,
    superseded: 0,
    overrodeConflict: null,
    ...over,
  };
}

// ── revisions.ts spies (reset per test) ─────────────────────────────────────
const listRevisions = mock.fn<(layoutId: string) => Promise<unknown[]>>(async () => []);
const getRevision = mock.fn<(id: string) => Promise<unknown>>(async () => null);
const createDraft = mock.fn<(input: Record<string, unknown>) => Promise<unknown>>(async () => revisionRow());
const publishRevision = mock.fn<(id: string, opts: { userId: string; force?: boolean }) => Promise<unknown>>(
  async () => publishResult(),
);
const restoreRevision = mock.fn<(id: string, opts: { userId: string; which: string }) => Promise<unknown>>(
  async () => publishResult(),
);
const discardDraft = mock.fn<(id: string) => Promise<void>>(async () => {});
const recordBuilderPublish = mock.fn<(input: Record<string, unknown>) => Promise<unknown>>(async () => null);
const ALL_SPIES = [listRevisions, getRevision, createDraft, publishRevision, restoreRevision, discardDraft];

// ── db (only what the routes read directly) ─────────────────────────────────
let layouts = new Map<string, { id: string; definition: unknown; version: number; status: string }>();
const findLayout = mock.fn(async (args: { where: { id: string } }) => {
  const row = layouts.get(args.where.id);
  return row ? structuredClone(row) : null;
});
const updateLayout = mock.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
  const row = layouts.get(args.where.id)!;
  row.status = "PUBLISHED";
  row.version += 1;
  return structuredClone(row);
});
const refreshLayoutVariants = mock.fn(async () => {});

before(() => {
  mock.module("@/lib/auth-server", {
    namedExports: {
      getSessionWithRole: async () => sessionState,
      // The builder publish route's gate.
      requireRole: async (roles: string[]) => {
        if (!sessionState.session) return { ok: false, status: 401, error: "Not signed in" };
        if (!sessionState.role || !roles.includes(sessionState.role)) {
          return { ok: false, status: 403, error: `Requires role: ${roles.join(" or ")}` };
        }
        return { ok: true, userId: (sessionState.session as { user: { id: string } }).user.id, role: sessionState.role };
      },
    },
  });
  mock.module("@/lib/db", {
    namedExports: { db: { outputLayout: { findUnique: findLayout, update: updateLayout } } },
  });
  mock.module("@/lib/output-layouts/variants", { namedExports: { refreshLayoutVariants } });
  mock.module("@/lib/output-layouts/revisions", {
    namedExports: {
      listRevisions,
      getRevision,
      createDraft,
      publishRevision,
      restoreRevision,
      discardDraft,
      recordBuilderPublish,
      RevisionNotFoundError,
      RevisionStateError,
      RevisionConflictError,
      RevisionValidationError,
    },
  });
});

beforeEach(() => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  asAdmin();
  for (const spy of [...ALL_SPIES, recordBuilderPublish, findLayout, updateLayout, refreshLayoutVariants]) {
    spy.mock.resetCalls();
  }
  listRevisions.mock.mockImplementation(async () => []);
  getRevision.mock.mockImplementation(async () => null);
  createDraft.mock.mockImplementation(async () => revisionRow());
  publishRevision.mock.mockImplementation(async () => publishResult());
  restoreRevision.mock.mockImplementation(async () => publishResult());
  discardDraft.mock.mockImplementation(async () => {});
  recordBuilderPublish.mock.mockImplementation(async () => null);
  layouts = new Map([["bogus-layout", { id: "bogus-layout", definition: structuredClone(LIVE), version: 1, status: "DRAFT" }]]);
});

// ── Calling the handlers ────────────────────────────────────────────────────
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function handler(path: string, method: "GET" | "POST"): Promise<Handler> {
  const mod = (await import(path)) as Record<string, Handler>;
  return mod[method];
}

async function call(
  path: string,
  method: "GET" | "POST",
  params: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fn = await handler(path, method);
  const init: { method: string; body?: string; headers?: Record<string, string> } = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await fn(new NextRequest("http://localhost/api/admin/output-layouts/x", init), {
    params: Promise.resolve(params),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.clone().json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  return { status: res.status, body: json };
}

const LIST = "@/app/api/admin/output-layouts/[id]/revisions/route";
const ONE = "@/app/api/admin/output-layouts/revisions/[revisionId]/route";
const PUBLISH = "@/app/api/admin/output-layouts/revisions/[revisionId]/publish/route";
const RESTORE = "@/app/api/admin/output-layouts/revisions/[revisionId]/restore/route";
const DISCARD = "@/app/api/admin/output-layouts/revisions/[revisionId]/discard/route";
const BUILDER_PUBLISH = "@/app/api/admin/output-layouts/[id]/publish/route";

const LAYOUT_PARAMS = { id: "bogus-layout" };
const REV_PARAMS = { revisionId: "bogus-rev" };

const ROUTES: Array<{ name: string; path: string; method: "GET" | "POST"; params: Record<string, string>; body?: unknown }> = [
  { name: "GET revisions", path: LIST, method: "GET", params: LAYOUT_PARAMS },
  { name: "POST revisions (create draft)", path: LIST, method: "POST", params: LAYOUT_PARAMS, body: {} },
  { name: "GET revision", path: ONE, method: "GET", params: REV_PARAMS },
  { name: "POST publish", path: PUBLISH, method: "POST", params: REV_PARAMS, body: {} },
  { name: "POST restore", path: RESTORE, method: "POST", params: REV_PARAMS, body: { which: "base" } },
  { name: "POST discard", path: DISCARD, method: "POST", params: REV_PARAMS },
];

function assertNothingReached(label: string) {
  for (const spy of ALL_SPIES) assert.equal(spy.mock.callCount(), 0, `${label}: revisions.ts not reached`);
  assert.equal(findLayout.mock.callCount(), 0, `${label}: db not reached`);
}

// ── The gate trio ───────────────────────────────────────────────────────────

for (const r of ROUTES) {
  test(`${r.name}: 404 while CHANGE_REQUESTS_ENABLED is off — even for an admin`, async () => {
    delete process.env.CHANGE_REQUESTS_ENABLED;
    const res = await call(r.path, r.method, r.params, r.body);
    assert.equal(res.status, 404);
    assertNothingReached(r.name);
  });

  test(`${r.name}: 401 without a session`, async () => {
    asAnon();
    const res = await call(r.path, r.method, r.params, r.body);
    assert.equal(res.status, 401);
    assertNothingReached(r.name);
  });

  test(`${r.name}: 403 for a REVIEWER (ADMIN only)`, async () => {
    asReviewer();
    const res = await call(r.path, r.method, r.params, r.body);
    assert.equal(res.status, 403);
    assertNothingReached(r.name);
  });
}

// ── GET / POST /api/admin/output-layouts/[id]/revisions ─────────────────────

test("GET revisions: the layout's summaries from listRevisions", async () => {
  const summary = { id: "bogus-rev", number: 3, status: "DRAFT" };
  listRevisions.mock.mockImplementation(async () => [summary]);
  const res = await call(LIST, "GET", LAYOUT_PARAMS);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { revisions: [summary] });
  assert.deepEqual(listRevisions.mock.calls[0].arguments, ["bogus-layout"]);
});

test("GET revisions: 404 for an unknown layout", async () => {
  const res = await call(LIST, "GET", { id: "no-such-layout" });
  assert.equal(res.status, 404);
  assert.equal(listRevisions.mock.callCount(), 0);
});

test("POST revisions: no definition → a USER draft copied from the live layout", async () => {
  const res = await call(LIST, "POST", LAYOUT_PARAMS);
  assert.equal(res.status, 201);
  assert.equal(createDraft.mock.callCount(), 1);
  assert.deepEqual(createDraft.mock.calls[0].arguments[0], {
    layoutId: "bogus-layout",
    definition: LIVE,
    authorKind: "USER",
    authorUserId: "admin-1",
    note: null,
  });
  const revision = res.body.revision as Record<string, unknown>;
  assert.equal(revision.id, "bogus-rev");
  assert.ok(!("definition" in revision) && !("baseDefinition" in revision), "a summary, not the blobs");
});

test("POST revisions: a given definition and note go to createDraft as they are", async () => {
  const res = await call(LIST, "POST", LAYOUT_PARAMS, { definition: PROPOSED, note: "  Add the polybag qty  " });
  assert.equal(res.status, 201);
  const input = createDraft.mock.calls[0].arguments[0];
  assert.deepEqual(input.definition, PROPOSED);
  assert.equal(input.note, "Add the polybag qty");
  assert.equal(findLayout.mock.callCount(), 0, "no live read needed");
});

test("POST revisions: an invalid definition answers 422 with the details", async () => {
  createDraft.mock.mockImplementation(async () => {
    throw new RevisionValidationError("Draft definition is invalid", ["definition must be a layout object with pages"]);
  });
  const res = await call(LIST, "POST", LAYOUT_PARAMS, { definition: { nope: true } });
  assert.equal(res.status, 422);
  assert.deepEqual(res.body, {
    error: "Draft definition is invalid",
    details: ["definition must be a layout object with pages"],
  });
});

test("POST revisions: unknown layout 404s (with or without a definition); bad JSON 400s", async () => {
  assert.equal((await call(LIST, "POST", { id: "no-such-layout" })).status, 404);
  assert.equal(createDraft.mock.callCount(), 0);

  createDraft.mock.mockImplementation(async () => {
    throw new RevisionNotFoundError("layout", "no-such-layout");
  });
  const withDef = await call(LIST, "POST", { id: "no-such-layout" }, { definition: PROPOSED });
  assert.equal(withDef.status, 404);
  assert.equal(withDef.body.error, "Layout not found");

  assert.equal((await call(LIST, "POST", LAYOUT_PARAMS, "{not json")).status, 400);
  assert.equal((await call(LIST, "POST", LAYOUT_PARAMS, { note: 42 })).status, 400);
});

// ── GET /api/admin/output-layouts/revisions/[revisionId] ────────────────────

test("GET revision: the full row plus the plain-English changes, base → definition", async () => {
  getRevision.mock.mockImplementation(async () => revisionRow());
  const res = await call(ONE, "GET", REV_PARAMS);
  assert.equal(res.status, 200);
  assert.deepEqual(getRevision.mock.calls[0].arguments, ["bogus-rev"]);
  const revision = res.body.revision as Record<string, unknown>;
  assert.deepEqual(revision.definition, PROPOSED);
  assert.deepEqual(revision.baseDefinition, LIVE);
  const changes = res.body.changes as { kind: string; summary: string }[];
  assert.ok(Array.isArray(changes) && changes.length > 0, "the added line is described");
  assert.ok(changes.every((c) => typeof c.summary === "string" && c.summary.length > 0));
  assert.ok(changes.some((c) => c.kind === "text"));
});

test("GET revision: identical definitions → no changes; unknown id → 404", async () => {
  getRevision.mock.mockImplementation(async () => revisionRow({ definition: LIVE }));
  assert.deepEqual((await call(ONE, "GET", REV_PARAMS)).body.changes, []);

  getRevision.mock.mockImplementation(async () => null);
  const missing = await call(ONE, "GET", REV_PARAMS);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "Revision not found");
});

// ── POST …/publish ──────────────────────────────────────────────────────────

test("publish: calls publishRevision as the admin; force only when asked", async () => {
  const res = await call(PUBLISH, "POST", REV_PARAMS);
  assert.equal(res.status, 200);
  assert.deepEqual(publishRevision.mock.calls[0].arguments, ["bogus-rev", { userId: "admin-1", force: false }]);
  assert.equal(res.body.publishedVersion, 2);
  assert.deepEqual(res.body.layout, { id: "bogus-layout", status: "PUBLISHED", version: 2 });
  const revision = res.body.revision as Record<string, unknown>;
  assert.equal(revision.status, "PUBLISHED");
  assert.ok(!("definition" in revision) && !("baseDefinition" in revision));

  await call(PUBLISH, "POST", REV_PARAMS, { force: true });
  assert.deepEqual(publishRevision.mock.calls[1].arguments, ["bogus-rev", { userId: "admin-1", force: true }]);

  assert.equal((await call(PUBLISH, "POST", REV_PARAMS, { force: "yes" })).status, 400);
  assert.equal(publishRevision.mock.callCount(), 2, "a bad body never publishes");
});

test("publish: a conflict answers 409 with what moved", async () => {
  const conflict = { baseVersion: 1, liveVersion: 1, versionChanged: false, definitionChanged: true };
  publishRevision.mock.mockImplementation(async () => {
    throw new RevisionConflictError(conflict);
  });
  const res = await call(PUBLISH, "POST", REV_PARAMS);
  assert.equal(res.status, 409);
  assert.match(res.body.error as string, /edited in the Output Builder/);
  assert.deepEqual(res.body.conflict, conflict);
});

test("publish: not a draft → 409 without a conflict; unknown → 404; failing the gate → 422 with details", async () => {
  publishRevision.mock.mockImplementation(async () => {
    throw new RevisionStateError("bogus-rev", "PUBLISHED", "Revision #3 is published — only a draft can be published");
  });
  const state = await call(PUBLISH, "POST", REV_PARAMS);
  assert.equal(state.status, 409);
  assert.deepEqual(state.body, { error: "Revision #3 is published — only a draft can be published" });

  publishRevision.mock.mockImplementation(async () => {
    throw new RevisionNotFoundError("revision", "bogus-rev");
  });
  const missing = await call(PUBLISH, "POST", REV_PARAMS);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "Revision not found" });

  publishRevision.mock.mockImplementation(async () => {
    throw new RevisionValidationError("Layout can't be published", ['unknown variable "noSuchToken"']);
  });
  const invalid = await call(PUBLISH, "POST", REV_PARAMS);
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body, { error: "Layout can't be published", details: ['unknown variable "noSuchToken"'] });
});

test("publish: an unexpected error is not dressed up as a revision error", async () => {
  publishRevision.mock.mockImplementation(async () => {
    throw new Error("connection lost");
  });
  await assert.rejects(call(PUBLISH, "POST", REV_PARAMS), /connection lost/);
});

// ── POST …/restore ──────────────────────────────────────────────────────────

test("restore: passes which through as the admin", async () => {
  for (const which of ["definition", "base"] as const) {
    const res = await call(RESTORE, "POST", REV_PARAMS, { which });
    assert.equal(res.status, 200);
    assert.deepEqual(restoreRevision.mock.calls.at(-1)!.arguments, ["bogus-rev", { userId: "admin-1", which }]);
    assert.equal(res.body.publishedVersion, 2);
  }
});

test("restore: which is required and must be definition | base", async () => {
  assert.equal((await call(RESTORE, "POST", REV_PARAMS)).status, 400);
  assert.equal((await call(RESTORE, "POST", REV_PARAMS, { which: "latest" })).status, 400);
  assert.equal(restoreRevision.mock.callCount(), 0);
});

test("restore: a never-published draft 409s; an old definition failing today's gate 422s with details", async () => {
  restoreRevision.mock.mockImplementation(async () => {
    throw new RevisionStateError("bogus-rev", "DRAFT", "Revision #3 was never published");
  });
  const state = await call(RESTORE, "POST", REV_PARAMS, { which: "definition" });
  assert.equal(state.status, 409);
  assert.equal(state.body.error, "Revision #3 was never published");

  restoreRevision.mock.mockImplementation(async () => {
    throw new RevisionValidationError("Layout can't be published", ["layout has no blocks — nothing would print"]);
  });
  const invalid = await call(RESTORE, "POST", REV_PARAMS, { which: "base" });
  assert.equal(invalid.status, 422);
  assert.deepEqual(invalid.body.details, ["layout has no blocks — nothing would print"]);
});

// ── POST …/discard ──────────────────────────────────────────────────────────

test("discard: discards the draft; a non-draft 409s; unknown 404s", async () => {
  const ok = await call(DISCARD, "POST", REV_PARAMS);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  assert.deepEqual(discardDraft.mock.calls[0].arguments, ["bogus-rev"]);

  discardDraft.mock.mockImplementation(async () => {
    throw new RevisionStateError("bogus-rev", "PUBLISHED", "Revision #3 is published — only a draft can be discarded");
  });
  assert.equal((await call(DISCARD, "POST", REV_PARAMS)).status, 409);

  discardDraft.mock.mockImplementation(async () => {
    throw new RevisionNotFoundError("revision", "bogus-rev");
  });
  assert.equal((await call(DISCARD, "POST", REV_PARAMS)).status, 404);
});

// ── The Output Builder's own publish route ──────────────────────────────────

test("builder publish: records the published version in the layout history", async () => {
  const res = await call(BUILDER_PUBLISH, "POST", LAYOUT_PARAMS);
  assert.equal(res.status, 200);
  assert.equal(recordBuilderPublish.mock.callCount(), 1);
  assert.deepEqual(recordBuilderPublish.mock.calls[0].arguments[0], {
    layoutId: "bogus-layout",
    definition: LIVE,
    publishedVersion: 2,
    userId: "admin-1",
  });
});

test("builder publish: still succeeds, unchanged, when the history write throws", async () => {
  recordBuilderPublish.mock.mockImplementation(async () => {
    throw new Error("history table on fire");
  });
  const warn = mock.method(console, "warn", () => {});
  try {
    const res = await call(BUILDER_PUBLISH, "POST", LAYOUT_PARAMS);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      layout: { id: "bogus-layout", status: "PUBLISHED", version: 2 },
      variantKey: "layout:bogus-layout",
    });
    assert.equal(recordBuilderPublish.mock.callCount(), 1);
    assert.equal(refreshLayoutVariants.mock.callCount(), 1);
    assert.equal(warn.mock.callCount(), 1, "the failure is logged, not swallowed silently");
  } finally {
    warn.mock.restore();
  }
});

test("builder publish: no history write while the flag is off, or when the publish itself fails", async () => {
  delete process.env.CHANGE_REQUESTS_ENABLED;
  assert.equal((await call(BUILDER_PUBLISH, "POST", LAYOUT_PARAMS)).status, 200);
  assert.equal(recordBuilderPublish.mock.callCount(), 0);

  process.env.CHANGE_REQUESTS_ENABLED = "true";
  layouts.set("bogus-layout", { id: "bogus-layout", definition: def(["{{noSuchToken}}"]), version: 1, status: "DRAFT" });
  assert.equal((await call(BUILDER_PUBLISH, "POST", LAYOUT_PARAMS)).status, 422);
  assert.equal(recordBuilderPublish.mock.callCount(), 0);
});
