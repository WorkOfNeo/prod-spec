// recordBuilderPublish (revisions.ts): the history row the Output Builder's
// own Publish button leaves behind, so the History panel can show and restore
// that version. Real revisions.ts over an in-memory revisions table:
//
//   • the row is a PUBLISHED snapshot — definition = base = what was published,
//     baseVersion = publishedVersion — numbered after the layout's last row,
//   • a numbering race retries; a missing table (migration not deployed) is a
//     silent no-op; anything else throws for the caller to handle,
//   • end to end, the builder publish route records it with the flag on, and
//     a missing table neither fails the publish nor logs.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
let revisions: Row[] = [];
let layouts = new Map<string, Row>();
let idSeq = 0;
// Next create() throws this (once), before writing.
let failNextCreate: Error | null = null;
// Every create() throws P2021 (table not deployed).
let tableMissing = false;
// Before the next create(), another writer takes this number.
let raceNumber: number | null = null;

const prismaError = (code: string, message: string) => Object.assign(new Error(message), { code });

const fakeDb = {
  outputLayout: {
    findUnique: async (args: { where: { id: string } }) => structuredClone(layouts.get(args.where.id) ?? null),
    update: async (args: { where: { id: string }; data: Row }) => {
      const row = layouts.get(args.where.id)!;
      row.status = "PUBLISHED";
      row.version = (row.version as number) + 1;
      return structuredClone(row);
    },
  },
  outputLayoutRevision: {
    findFirst: async (args: { where: { layoutId: string } }) => {
      if (tableMissing) throw prismaError("P2021", "The table `output_layout_revisions` does not exist");
      const rows = revisions
        .filter((r) => r.layoutId === args.where.layoutId)
        .sort((a, b) => (b.number as number) - (a.number as number));
      return rows[0] ? { number: rows[0].number } : null;
    },
    create: async (args: { data: Row }) => {
      if (tableMissing) throw prismaError("P2021", "The table `output_layout_revisions` does not exist");
      if (failNextCreate) {
        const err = failNextCreate;
        failNextCreate = null;
        throw err;
      }
      if (raceNumber !== null) {
        revisions.push({ id: "rev-other", layoutId: args.data.layoutId, number: raceNumber });
        raceNumber = null;
      }
      if (revisions.some((r) => r.layoutId === args.data.layoutId && r.number === args.data.number)) {
        throw prismaError("P2002", "Unique constraint failed on the fields: (`layoutId`,`number`)");
      }
      const row = { id: `rev-${++idSeq}`, createdAt: new Date(0), ...structuredClone(args.data) };
      revisions.push(row);
      return structuredClone(row);
    },
  },
};

before(() => {
  mock.module("@/lib/db", { namedExports: { db: fakeDb } });
  mock.module("@/lib/output-layouts/variants", { namedExports: { refreshLayoutVariants: async () => {} } });
  mock.module("@/lib/auth-server", {
    namedExports: { requireRole: async () => ({ ok: true, userId: "admin-1", role: "ADMIN" }) },
  });
});

const DEF = {
  pages: [
    {
      id: "p1",
      widthMm: 50,
      heightMm: 60,
      gridCols: 12,
      gridRows: 15,
      blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 2 }, lines: ["{{styleNumber}}"] }],
    },
  ],
};

beforeEach(() => {
  revisions = [];
  layouts = new Map([["bogus-layout", { id: "bogus-layout", definition: structuredClone(DEF), version: 0, status: "DRAFT" }]]);
  idSeq = 0;
  failNextCreate = null;
  tableMissing = false;
  raceNumber = null;
  delete process.env.CHANGE_REQUESTS_ENABLED;
});

const input = { layoutId: "bogus-layout", definition: DEF, publishedVersion: 4, userId: "admin-1" };

test("writes a PUBLISHED snapshot row after the layout's last revision", async () => {
  const { recordBuilderPublish, BUILDER_PUBLISH_NOTE } = await import("@/lib/output-layouts/revisions");
  revisions.push({ id: "rev-old", layoutId: "bogus-layout", number: 2 });
  revisions.push({ id: "rev-elsewhere", layoutId: "other-layout", number: 9 });

  const row = await recordBuilderPublish(input);
  assert.ok(row);
  assert.equal(row.number, 3);
  assert.equal(row.status, "PUBLISHED");
  assert.deepEqual(row.definition, DEF);
  assert.deepEqual(row.baseDefinition, DEF);
  assert.equal(row.baseVersion, 4);
  assert.equal(row.publishedVersion, 4);
  assert.equal(row.authorKind, "USER");
  assert.equal(row.authorUserId, "admin-1");
  assert.equal(row.publishedById, "admin-1");
  assert.ok(row.publishedAt instanceof Date);
  assert.equal(row.note, BUILDER_PUBLISH_NOTE);
});

test("a numbering race takes the next number", async () => {
  const { recordBuilderPublish } = await import("@/lib/output-layouts/revisions");
  raceNumber = 1;
  const row = await recordBuilderPublish(input);
  assert.equal(row?.number, 2);
});

test("a missing table is a silent no-op; any other failure throws", async () => {
  const { recordBuilderPublish } = await import("@/lib/output-layouts/revisions");
  tableMissing = true;
  assert.equal(await recordBuilderPublish(input), null);

  tableMissing = false;
  failNextCreate = new Error("connection lost");
  await assert.rejects(recordBuilderPublish(input), /connection lost/);
  assert.equal(revisions.length, 0);
});

async function builderPublish() {
  const { POST } = await import("@/app/api/admin/output-layouts/[id]/publish/route");
  const res = await POST(new NextRequest("http://localhost/api/admin/output-layouts/bogus-layout/publish", { method: "POST" }), {
    params: Promise.resolve({ id: "bogus-layout" }),
  });
  return { status: res.status, body: await res.json() };
}

test("builder publish, flag on: the published version lands in the history", async () => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  const { status, body } = await builderPublish();
  assert.equal(status, 200);
  assert.equal(body.layout.version, 1);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].publishedVersion, 1);
  assert.deepEqual(revisions[0].definition, DEF);
});

test("builder publish, flag on, table not deployed: publishes, writes nothing, logs nothing", async () => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  tableMissing = true;
  const warn = mock.method(console, "warn", () => {});
  try {
    const { status, body } = await builderPublish();
    assert.equal(status, 200);
    assert.deepEqual(body, {
      layout: { id: "bogus-layout", status: "PUBLISHED", version: 1 },
      variantKey: "layout:bogus-layout",
    });
    assert.equal(warn.mock.callCount(), 0);
  } finally {
    warn.mock.restore();
  }
});

test("builder publish, flag off: no history row", async () => {
  assert.equal((await builderPublish()).status, 200);
  assert.equal(revisions.length, 0);
});
