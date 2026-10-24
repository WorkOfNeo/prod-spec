// Layout revisions: the DB orchestration around the pure decisions tested in
// src/lib/output-layouts/revisions.test.ts. An in-memory stand-in for the two
// Prisma delegates (with a rolling-back $transaction) lets these tests pin the
// guarantees that matter without a database:
//
//   • a draft never changes what prints,
//   • publish writes the definition, bumps the version, marks the revision
//     PUBLISHED and the layout's other open drafts SUPERSEDED — all in ONE
//     transaction — and then refreshes the variant registry,
//   • publish refuses when the live layout moved (builder autosave, another
//     publish), unless forced, including a move that lands between the check
//     and the write,
//   • readers degrade to empty while the table isn't deployed.
//
// The Output Builder's own publish route, now built on the shared gate, is
// driven at the end to show its responses are unchanged.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { NextRequest } from "next/server";
import { parseLayoutDef } from "@/lib/output-layouts/schema";

// ── In-memory tables ────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
type State = { layouts: Map<string, Row>; revisions: Row[] };
let state: State = { layouts: new Map(), revisions: [] };
let idSeq = 0;
let inTx = false;
// Every write, with whether it happened inside $transaction.
let writes: { op: string; inTx: boolean }[] = [];
// Order of notable events (transaction commit vs registry refresh).
let events: string[] = [];
// Reads of output_layout_revisions throw P2021 (table not deployed yet).
let revisionsTableMissing = false;
// Test hooks, each run once: before the next revision insert, and as the next
// transaction opens (a write from ANOTHER connection, so not rolled back).
let beforeRevisionCreate: (() => void) | null = null;
let beforeTransaction: (() => void) | null = null;

const prismaError = (code: string, message: string) => Object.assign(new Error(message), { code });

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      const c = cond as Row;
      if ("not" in c) return row[key] !== c.not;
      if ("equals" in c) return isDeepStrictEqual(row[key], c.equals);
      if ("in" in c) return (c.in as unknown[]).includes(row[key]);
    }
    return row[key] === cond;
  });
}

function project(row: Row, args: { select?: Row; omit?: Row; include?: Row }): Row {
  let out: Row = structuredClone(row);
  if (args.select) {
    out = Object.fromEntries(Object.keys(args.select).filter((k) => args.select![k]).map((k) => [k, out[k]]));
  }
  if (args.omit) for (const k of Object.keys(args.omit)) delete out[k];
  if (args.include?.layout) {
    const layout = state.layouts.get(row.layoutId as string)!;
    out.layout = project(layout, args.include.layout as Row);
  }
  return out;
}

function sortByNumberDesc(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => (b.number as number) - (a.number as number));
}

function write(op: string) {
  writes.push({ op, inTx });
}

function guardMissing() {
  if (revisionsTableMissing) throw prismaError("P2021", "The table `output_layout_revisions` does not exist");
}

const fakeDb = {
  outputLayout: {
    findUnique: async (args: { where: { id: string }; select?: Row }) => {
      const row = state.layouts.get(args.where.id);
      return row ? project(row, args) : null;
    },
    update: async (args: { where: Row; data: Row; select?: Row }) => {
      write("outputLayout.update");
      const row = state.layouts.get(args.where.id as string);
      if (!row || !matches(row, args.where)) throw prismaError("P2025", "Record to update not found.");
      for (const [k, v] of Object.entries(args.data)) {
        if (v && typeof v === "object" && "increment" in (v as Row)) {
          row[k] = (row[k] as number) + ((v as Row).increment as number);
        } else {
          row[k] = structuredClone(v);
        }
      }
      return project(row, args);
    },
  },
  outputLayoutRevision: {
    findUnique: async (args: { where: { id: string }; select?: Row; include?: Row }) => {
      guardMissing();
      const row = state.revisions.find((r) => r.id === args.where.id);
      return row ? project(row, args) : null;
    },
    findFirst: async (args: { where: Row; select?: Row; omit?: Row }) => {
      guardMissing();
      const row = sortByNumberDesc(state.revisions.filter((r) => matches(r, args.where)))[0];
      return row ? project(row, args) : null;
    },
    findMany: async (args: { where: Row; omit?: Row }) => {
      guardMissing();
      return sortByNumberDesc(state.revisions.filter((r) => matches(r, args.where))).map((r) => project(r, args));
    },
    create: async (args: { data: Row }) => {
      if (beforeRevisionCreate) {
        const hook = beforeRevisionCreate;
        beforeRevisionCreate = null;
        hook();
      }
      write("outputLayoutRevision.create");
      const d = args.data;
      if (state.revisions.some((r) => r.layoutId === d.layoutId && r.number === d.number)) {
        throw prismaError("P2002", "Unique constraint failed on the fields: (`layoutId`,`number`)");
      }
      const row: Row = {
        id: `rev-${++idSeq}`,
        ops: null,
        publishedAt: null,
        publishedById: null,
        publishedVersion: null,
        createdAt: new Date(0),
        ...structuredClone(d),
      };
      state.revisions.push(row);
      return structuredClone(row);
    },
    update: async (args: { where: Row; data: Row }) => {
      write("outputLayoutRevision.update");
      const row = state.revisions.find((r) => matches(r, args.where));
      if (!row) throw prismaError("P2025", "Record to update not found.");
      Object.assign(row, structuredClone(args.data));
      return structuredClone(row);
    },
    updateMany: async (args: { where: Row; data: Row }) => {
      write("outputLayoutRevision.updateMany");
      const rows = state.revisions.filter((r) => matches(r, args.where));
      for (const r of rows) Object.assign(r, structuredClone(args.data));
      return { count: rows.length };
    },
  },
  // Interactive transaction: same delegates, rolled back on throw.
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    if (beforeTransaction) {
      const hook = beforeTransaction;
      beforeTransaction = null;
      hook();
    }
    const snapshot = structuredClone(state);
    inTx = true;
    try {
      const result = await fn(fakeDb);
      events.push("commit");
      return result;
    } catch (err) {
      state = snapshot;
      events.push("rollback");
      throw err;
    } finally {
      inTx = false;
    }
  },
};

const refreshLayoutVariants = mock.fn(async () => {
  events.push("refresh");
});

// ── Session for the builder publish route ───────────────────────────────────
let role: "ADMIN" | "REVIEWER" | null = "ADMIN";

before(() => {
  mock.module("@/lib/db", { namedExports: { db: fakeDb } });
  mock.module("@/lib/output-layouts/variants", { namedExports: { refreshLayoutVariants } });
  mock.module("@/lib/auth-server", {
    namedExports: {
      requireRole: async (roles: string[]) => {
        if (!role) return { ok: false, status: 401, error: "Not signed in" };
        if (!roles.includes(role)) return { ok: false, status: 403, error: `Requires role: ${roles.join(" or ")}` };
        return { ok: true, userId: "admin-1", role };
      },
    },
  });
});

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

function seedLayout(id: string, definition: unknown = LIVE, version = 1, status = "PUBLISHED") {
  state.layouts.set(id, { id, name: `Layout ${id}`, definition: structuredClone(definition), version, status });
}

function layoutRow(id: string) {
  return state.layouts.get(id)!;
}

function revisionRow(id: string) {
  return state.revisions.find((r) => r.id === id)!;
}

beforeEach(() => {
  state = { layouts: new Map(), revisions: [] };
  idSeq = 0;
  inTx = false;
  writes = [];
  events = [];
  revisionsTableMissing = false;
  beforeRevisionCreate = null;
  beforeTransaction = null;
  role = "ADMIN";
  refreshLayoutVariants.mock.resetCalls();
  seedLayout("bogus-layout");
});

// ── Drafts ──────────────────────────────────────────────────────────────────

test("createDraft snapshots the live layout and never touches it", async () => {
  const { createDraft } = await import("@/lib/output-layouts/revisions");

  const draft = await createDraft({
    layoutId: "bogus-layout",
    definition: PROPOSED,
    authorKind: "AGENT",
    changeRequestOutputId: "bogus-output",
    ops: [{ op: "insert_line" }],
    note: "add the polybag quantity",
  });

  assert.equal(draft.number, 1);
  assert.equal(draft.status, "DRAFT");
  assert.deepEqual(draft.baseDefinition, LIVE);
  assert.equal(draft.baseVersion, 1);
  assert.equal(draft.authorKind, "AGENT");
  assert.equal(draft.changeRequestOutputId, "bogus-output");
  assert.deepEqual(draft.ops, [{ op: "insert_line" }]);
  assert.equal((draft.definition as typeof PROPOSED).pages[0].blocks[0].lines.length, 2);

  // What prints is untouched.
  assert.deepEqual(layoutRow("bogus-layout").definition, LIVE);
  assert.equal(layoutRow("bogus-layout").version, 1);
  assert.deepEqual(
    writes.map((w) => w.op),
    ["outputLayoutRevision.create"],
  );

  const second = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "USER" });
  assert.equal(second.number, 2);
  assert.equal(second.ops, null);
});

test("createDraft refuses garbage and unknown layouts, writing nothing", async () => {
  const { createDraft, RevisionValidationError, RevisionNotFoundError } = await import(
    "@/lib/output-layouts/revisions"
  );

  await assert.rejects(
    createDraft({ layoutId: "bogus-layout", definition: {}, authorKind: "AGENT" }),
    RevisionValidationError,
  );
  await assert.rejects(
    createDraft({ layoutId: "no-such-layout", definition: PROPOSED, authorKind: "AGENT" }),
    (err: unknown) => err instanceof RevisionNotFoundError && err.what === "layout",
  );
  assert.equal(writes.length, 0);
});

test("createDraft takes the next number when it loses a numbering race", async () => {
  const { createDraft } = await import("@/lib/output-layouts/revisions");

  // A competing draft lands with number 1 between our read and our insert.
  beforeRevisionCreate = () => {
    state.revisions.push({ id: "rev-competitor", layoutId: "bogus-layout", number: 1, status: "DRAFT" });
  };
  const draft = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  assert.equal(draft.number, 2);
});

test("reviseDraft links the parent, keeps its layout and output, and leaves it open", async () => {
  const { createDraft, reviseDraft } = await import("@/lib/output-layouts/revisions");

  const parent = await createDraft({
    layoutId: "bogus-layout",
    definition: PROPOSED,
    authorKind: "AGENT",
    changeRequestOutputId: "bogus-output",
  });
  const child = await reviseDraft(parent.id, { definition: PROPOSED, authorKind: "AGENT", note: "smaller font" });

  assert.equal(child.parentRevisionId, parent.id);
  assert.equal(child.layoutId, "bogus-layout");
  assert.equal(child.changeRequestOutputId, "bogus-output");
  assert.equal(child.number, 2);
  assert.equal(revisionRow(parent.id).status, "DRAFT");
});

// ── Publish ─────────────────────────────────────────────────────────────────

test("publish writes definition + version, supersedes other drafts, in one transaction, then refreshes", async () => {
  const { createDraft, publishRevision } = await import("@/lib/output-layouts/revisions");
  seedLayout("other-layout");

  const r1 = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  const r2 = await createDraft({ layoutId: "bogus-layout", definition: LIVE, authorKind: "USER" });
  const elsewhere = await createDraft({ layoutId: "other-layout", definition: PROPOSED, authorKind: "AGENT" });
  writes = [];

  const res = await publishRevision(r1.id, { userId: "admin-1" });

  const layout = layoutRow("bogus-layout");
  assert.deepEqual(layout.definition, r1.definition);
  assert.equal(layout.version, 2);
  assert.equal(layout.status, "PUBLISHED");

  const published = revisionRow(r1.id);
  assert.equal(published.status, "PUBLISHED");
  assert.equal(published.publishedVersion, 2);
  assert.equal(published.publishedById, "admin-1");
  assert.ok(published.publishedAt instanceof Date);

  assert.equal(revisionRow(r2.id).status, "SUPERSEDED");
  assert.equal(revisionRow(elsewhere.id).status, "DRAFT", "another layout's drafts are not touched");

  assert.equal(res.publishedVersion, 2);
  assert.equal(res.superseded, 1);
  assert.equal(res.overrodeConflict, null);
  assert.deepEqual(res.layout, { id: "bogus-layout", status: "PUBLISHED", version: 2 });

  // Every write inside the one transaction; the registry refresh after commit.
  assert.ok(writes.length >= 3);
  assert.ok(
    writes.every((w) => w.inTx),
    JSON.stringify(writes),
  );
  assert.deepEqual(events, ["commit", "refresh"]);
  assert.equal(refreshLayoutVariants.mock.callCount(), 1);
});

test("publish refuses after a builder autosave (same version, new definition)", async () => {
  const { createDraft, publishRevision, RevisionConflictError } = await import("@/lib/output-layouts/revisions");

  const draft = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  layoutRow("bogus-layout").definition = def(["{{styleNumber}} edited in the builder"]);
  writes = [];

  await assert.rejects(publishRevision(draft.id, { userId: "admin-1" }), (err: unknown) => {
    assert.ok(err instanceof RevisionConflictError);
    assert.deepEqual(err.conflict, { baseVersion: 1, liveVersion: 1, versionChanged: false, definitionChanged: true });
    return true;
  });
  assert.equal(writes.length, 0);
  assert.equal(revisionRow(draft.id).status, "DRAFT");
  assert.equal(refreshLayoutVariants.mock.callCount(), 0);
});

test("publish refuses after another publish (version moved)", async () => {
  const { createDraft, publishRevision, RevisionConflictError } = await import("@/lib/output-layouts/revisions");

  const draft = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  layoutRow("bogus-layout").version = 2;

  await assert.rejects(
    publishRevision(draft.id, { userId: "admin-1" }),
    (err: unknown) => err instanceof RevisionConflictError && err.conflict.versionChanged,
  );
  assert.equal(layoutRow("bogus-layout").version, 2);
});

test("force publishes over a conflict and reports what it overwrote", async () => {
  const { createDraft, publishRevision } = await import("@/lib/output-layouts/revisions");

  const draft = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  layoutRow("bogus-layout").definition = def(["edited"]);

  const res = await publishRevision(draft.id, { userId: "admin-1", force: true });
  assert.deepEqual(layoutRow("bogus-layout").definition, draft.definition);
  assert.equal(layoutRow("bogus-layout").version, 2);
  assert.equal(res.overrodeConflict?.definitionChanged, true);
});

test("an autosave landing between the check and the write is caught and rolled back", async () => {
  const { createDraft, publishRevision, RevisionConflictError } = await import("@/lib/output-layouts/revisions");

  const draft = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  // Lands after publishRevision's own check, before its guarded write.
  beforeTransaction = () => {
    layoutRow("bogus-layout").definition = def(["autosaved meanwhile"]);
  };

  await assert.rejects(publishRevision(draft.id, { userId: "admin-1" }), RevisionConflictError);
  assert.deepEqual(layoutRow("bogus-layout").definition, def(["autosaved meanwhile"]), "the builder edit survives");
  assert.equal(layoutRow("bogus-layout").version, 1);
  assert.equal(revisionRow(draft.id).status, "DRAFT");
  assert.deepEqual(events, ["rollback"]);
  assert.equal(refreshLayoutVariants.mock.callCount(), 0);
});

test("only a draft can be published", async () => {
  const { createDraft, publishRevision, RevisionStateError, RevisionNotFoundError } = await import(
    "@/lib/output-layouts/revisions"
  );

  const draft = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  await publishRevision(draft.id, { userId: "admin-1" });
  await assert.rejects(publishRevision(draft.id, { userId: "admin-1" }), RevisionStateError);
  await assert.rejects(publishRevision("no-such-revision", { userId: "admin-1" }), RevisionNotFoundError);
});

test("publish runs the strict gate: a draft with an unknown variable never prints", async () => {
  const { createDraft, publishRevision, RevisionValidationError } = await import("@/lib/output-layouts/revisions");

  // Schema-valid, so the draft is accepted; the publish gate is stricter.
  const draft = await createDraft({ layoutId: "bogus-layout", definition: def(["{{noSuchToken}}"]), authorKind: "AGENT" });

  await assert.rejects(publishRevision(draft.id, { userId: "admin-1" }), (err: unknown) => {
    assert.ok(err instanceof RevisionValidationError);
    assert.equal(err.message, "Layout can't be published");
    assert.ok(err.details.some((d) => d.includes("noSuchToken")));
    return true;
  });
  assert.deepEqual(layoutRow("bogus-layout").definition, LIVE);
  assert.equal(revisionRow(draft.id).status, "DRAFT");
});

// ── Discard ─────────────────────────────────────────────────────────────────

test("discardDraft discards drafts only", async () => {
  const { createDraft, discardDraft, publishRevision, RevisionStateError, RevisionNotFoundError } = await import(
    "@/lib/output-layouts/revisions"
  );

  const a = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  await discardDraft(a.id);
  assert.equal(revisionRow(a.id).status, "DISCARDED");

  const b = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  await publishRevision(b.id, { userId: "admin-1" });
  await assert.rejects(discardDraft(b.id), RevisionStateError);
  assert.equal(revisionRow(b.id).status, "PUBLISHED");

  await assert.rejects(discardDraft("no-such-revision"), RevisionNotFoundError);
});

// ── Restore ─────────────────────────────────────────────────────────────────

test("restore 'base' puts back what was live before, as a new published revision", async () => {
  const { createDraft, publishRevision, restoreRevision } = await import("@/lib/output-layouts/revisions");

  const draft = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  await publishRevision(draft.id, { userId: "admin-1" });
  assert.equal(layoutRow("bogus-layout").version, 2);

  const res = await restoreRevision(draft.id, { userId: "admin-2", which: "base" });

  // Back to the old layout (normalised by the draft parse, as every draft is).
  assert.deepEqual(layoutRow("bogus-layout").definition, parseLayoutDef(LIVE));
  assert.equal(layoutRow("bogus-layout").version, 3, "history moves forward");
  assert.equal(res.revision.number, 2);
  assert.equal(res.revision.authorKind, "USER");
  assert.equal(res.revision.authorUserId, "admin-2");
  assert.equal(res.revision.status, "PUBLISHED");
  assert.match(res.revision.note ?? "", /before revision #1/);
  assert.equal(revisionRow(draft.id).status, "PUBLISHED", "the restored-from revision is untouched");
});

test("restore 'definition' of a published revision republishes it", async () => {
  const { createDraft, publishRevision, restoreRevision } = await import("@/lib/output-layouts/revisions");

  const first = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  await publishRevision(first.id, { userId: "admin-1" });
  const second = await createDraft({ layoutId: "bogus-layout", definition: LIVE, authorKind: "USER" });
  await publishRevision(second.id, { userId: "admin-1" });

  await restoreRevision(first.id, { userId: "admin-1", which: "definition" });
  assert.deepEqual(layoutRow("bogus-layout").definition, first.definition);
  assert.equal(layoutRow("bogus-layout").version, 4);
});

test("restore 'definition' refuses a draft that was never published", async () => {
  const { createDraft, restoreRevision, RevisionStateError } = await import("@/lib/output-layouts/revisions");

  const draft = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  writes = [];
  await assert.rejects(restoreRevision(draft.id, { userId: "admin-1", which: "definition" }), RevisionStateError);
  assert.equal(writes.length, 0);
  assert.deepEqual(layoutRow("bogus-layout").definition, LIVE);
});

test("a restore that can't publish leaves no open draft behind", async () => {
  const { createDraft, publishRevision, restoreRevision, openDraftFor, RevisionValidationError } = await import(
    "@/lib/output-layouts/revisions"
  );

  // The base was live once but no longer passes today's gate.
  seedLayout("bogus-layout", def(["{{retiredToken}}"]), 1);
  const draft = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  await publishRevision(draft.id, { userId: "admin-1" });

  await assert.rejects(restoreRevision(draft.id, { userId: "admin-1", which: "base" }), RevisionValidationError);
  assert.equal(await openDraftFor("bogus-layout"), null);
  assert.equal(state.revisions.at(-1)?.status, "DISCARDED");
  assert.deepEqual(layoutRow("bogus-layout").definition, draft.definition, "what prints is unchanged");
});

// ── Readers ─────────────────────────────────────────────────────────────────

test("listRevisions is newest first without the definition blobs; openDraftFor is the newest draft", async () => {
  const { createDraft, discardDraft, listRevisions, openDraftFor, getRevision } = await import(
    "@/lib/output-layouts/revisions"
  );

  const a = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  const b = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  const c = await createDraft({ layoutId: "bogus-layout", definition: PROPOSED, authorKind: "AGENT" });
  await discardDraft(c.id);

  const list = await listRevisions("bogus-layout");
  assert.deepEqual(
    list.map((r) => r.number),
    [3, 2, 1],
  );
  assert.equal("definition" in list[0], false);
  assert.equal("baseDefinition" in list[0], false);

  assert.equal((await openDraftFor("bogus-layout"))?.id, b.id);
  assert.deepEqual((await getRevision(a.id))?.baseDefinition, LIVE);
  assert.equal(await getRevision("no-such-revision"), null);
});

test("readers degrade to empty while the table isn't deployed", async () => {
  const { listRevisions, openDraftFor, getRevision } = await import("@/lib/output-layouts/revisions");
  revisionsTableMissing = true;

  assert.deepEqual(await listRevisions("bogus-layout"), []);
  assert.equal(await openDraftFor("bogus-layout"), null);
  assert.equal(await getRevision("rev-1"), null);
});

// ── The builder's publish route, on the shared gate ─────────────────────────

async function callPublishRoute(id: string) {
  const { POST } = await import("@/app/api/admin/output-layouts/[id]/publish/route");
  const res = await POST(new NextRequest(`http://localhost/api/admin/output-layouts/${id}/publish`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: await res.json() };
}

test("builder publish: a valid layout publishes exactly as before", async () => {
  const { status, body } = await callPublishRoute("bogus-layout");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    layout: { id: "bogus-layout", status: "PUBLISHED", version: 2 },
    variantKey: "layout:bogus-layout",
  });
  assert.equal(refreshLayoutVariants.mock.callCount(), 1);
});

test("builder publish: schema failures and gate failures answer 422 { error, details }", async () => {
  seedLayout("bogus-layout", { pages: [] }, 1);
  const invalid = await callPublishRoute("bogus-layout");
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error, "Layout definition is invalid");
  assert.ok(Array.isArray(invalid.body.details) && invalid.body.details.length > 0);

  seedLayout("bogus-layout", def(["{{noSuchToken}}"]), 1);
  const blocked = await callPublishRoute("bogus-layout");
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error, "Layout can't be published");
  assert.ok(blocked.body.details.some((d: string) => d.includes("noSuchToken")));

  assert.equal(layoutRow("bogus-layout").version, 1, "nothing published");
  assert.equal(refreshLayoutVariants.mock.callCount(), 0);
});

test("builder publish: gate and 404 unchanged", async () => {
  role = "REVIEWER";
  assert.equal((await callPublishRoute("bogus-layout")).status, 403);
  role = null;
  assert.equal((await callPublishRoute("bogus-layout")).status, 401);
  role = "ADMIN";
  assert.equal((await callPublishRoute("no-such-layout")).status, 404);
});
