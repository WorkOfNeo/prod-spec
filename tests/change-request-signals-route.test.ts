// Learning signals route, driven through the REAL handler with a mocked
// session over in-memory change-request tables:
//
//   • flag off → 404 before auth; ADMIN only (401 anonymous, 403 reviewer) —
//     the table shows agent cost and is an admin's view of the agent;
//   • outputSignals joins outputs, their revision chain (edit kinds from the
//     parent → child diff, including a parent that belongs to another output)
//     and summed step costs into one row per output, newest first;
//   • a missing table reads as an empty table with zero totals.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

type Role = "ADMIN" | "REVIEWER" | null;
let sessionState: { session: unknown; role: Role } = { session: null, role: null };
const as = (role: Exclude<Role, null>) => {
  sessionState = { session: { user: { id: `${role}-1`, email: `${role.toLowerCase()}@example.com` } }, role };
};
const asAnon = () => {
  sessionState = { session: null, role: null };
};

type Row = Record<string, unknown>;
let outputs: Row[] = [];
let revisions: Row[] = [];
let steps: Row[] = [];
let reads = 0;
let tableMissing = false;
let lastTake: number | undefined;

const missing = () => Object.assign(new Error("The table does not exist"), { code: "P2021" });

function inList(value: unknown, cond: unknown): boolean {
  return !!cond && typeof cond === "object" && "in" in (cond as Row) && ((cond as Row).in as unknown[]).includes(value);
}

const fakeDb = {
  changeRequestOutput: {
    findMany: async (args: { take?: number }) => {
      reads++;
      if (tableMissing) throw missing();
      lastTake = args.take;
      const sorted = [...outputs].sort(
        (a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime(),
      );
      return sorted.slice(0, args.take).map((o) => structuredClone(o));
    },
  },
  outputLayoutRevision: {
    findMany: async (args: { where: Row }) => {
      if (tableMissing) throw missing();
      return revisions
        .filter((r) =>
          "changeRequestOutputId" in args.where
            ? inList(r.changeRequestOutputId, args.where.changeRequestOutputId)
            : inList(r.id, args.where.id),
        )
        .map((r) => structuredClone(r));
    },
  },
  changeRequestStep: {
    groupBy: async (args: { where: Row }) => {
      if (tableMissing) throw missing();
      const sums = new Map<string, number | null>();
      for (const s of steps) {
        if (!inList(s.outputId, args.where.outputId)) continue;
        const prev = sums.get(s.outputId as string) ?? null;
        const cost = s.costUsd as number | null;
        sums.set(s.outputId as string, cost == null ? prev : (prev ?? 0) + cost);
      }
      return [...sums].map(([outputId, costUsd]) => ({ outputId, _sum: { costUsd } }));
    },
  },
};

before(() => {
  mock.module("@/lib/auth-server", { namedExports: { getSessionWithRole: async () => sessionState } });
  mock.module("@/lib/db", { namedExports: { db: fakeDb } });
});

const prevFlag = process.env.CHANGE_REQUESTS_ENABLED;
beforeEach(() => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  outputs = [];
  revisions = [];
  steps = [];
  reads = 0;
  tableMissing = false;
  lastTake = undefined;
  as("ADMIN");
});
after(() => {
  if (prevFlag === undefined) delete process.env.CHANGE_REQUESTS_ENABLED;
  else process.env.CHANGE_REQUESTS_ENABLED = prevFlag;
});

// Synthetic one-block sticker.
function def(lines: string[], fontPt = 8) {
  return {
    pages: [
      {
        id: "p1",
        widthMm: 50,
        heightMm: 60,
        gridCols: 50,
        gridRows: 60,
        blocks: [{ id: "b1", rect: { col: 2, row: 2, colSpan: 46, rowSpan: 6 }, fontPt, lines }],
      },
    ],
  };
}

function output(over: Row): Row {
  return {
    id: "out-x",
    requestId: "req-1",
    label: "Polybag sticker",
    status: "IN_REVIEW",
    draftCount: 1,
    firstTryApproved: null,
    approvedAt: null,
    createdAt: new Date("2026-10-24T09:00:00Z"),
    rejectReason: null,
    request: { number: 1 },
    ...over,
  };
}

const req = (qs = "") => new NextRequest(`http://localhost/api/admin/change-requests/signals${qs}`);

test("flag off: 404 for everyone, before auth, nothing read", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/signals/route");
  delete process.env.CHANGE_REQUESTS_ENABLED;
  asAnon();
  assert.equal((await GET(req())).status, 404);
  as("ADMIN");
  assert.equal((await GET(req())).status, 404);
  assert.equal(reads, 0);
});

test("anonymous 401, reviewer 403, nothing read", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/signals/route");
  asAnon();
  assert.equal((await GET(req())).status, 401);
  as("REVIEWER");
  assert.equal((await GET(req())).status, 403);
  assert.equal(reads, 0);
});

test("rows join revisions and step costs; totals summarise them", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/signals/route");
  outputs = [
    // Approved on the third draft: the reviewer asked for a bigger font, then new wording.
    output({
      id: "out-1",
      status: "PUBLISHED",
      draftCount: 3,
      firstTryApproved: false,
      approvedAt: new Date("2026-10-24T10:30:00Z"),
      createdAt: new Date("2026-10-24T09:00:00Z"),
    }),
    // Approved first time, on another request.
    output({
      id: "out-2",
      requestId: "req-2",
      request: { number: 2 },
      status: "PUBLISHED",
      draftCount: 1,
      firstTryApproved: true,
      approvedAt: new Date("2026-10-24T11:00:00Z"),
      createdAt: new Date("2026-10-24T10:00:00Z"),
    }),
    // Rejected after a revision whose parent belongs to an older output
    // outside the table (loaded by id in a second query).
    output({
      id: "out-3",
      requestId: "req-2",
      request: { number: 2 },
      status: "REJECTED",
      draftCount: 2,
      rejectReason: "Wrong output",
      createdAt: new Date("2026-10-24T11:00:00Z"),
    }),
  ];
  revisions = [
    { id: "r0", changeRequestOutputId: "out-old", parentRevisionId: null, definition: def(["{{size}}"]) },
    { id: "r1", changeRequestOutputId: "out-1", parentRevisionId: null, definition: def(["{{size}}"]) },
    { id: "r2", changeRequestOutputId: "out-1", parentRevisionId: "r1", definition: def(["{{size}}"], 10) },
    { id: "r3", changeRequestOutputId: "out-1", parentRevisionId: "r2", definition: def(["SIZE {{size}}"], 10) },
    { id: "r4", changeRequestOutputId: "out-2", parentRevisionId: null, definition: def(["x"]) },
    { id: "r5", changeRequestOutputId: "out-3", parentRevisionId: "r0", definition: def(["{{size}}", "PCS"]) },
    // A revision of an output outside the table never lands in a row.
    { id: "r6", changeRequestOutputId: "out-old", parentRevisionId: "r0", definition: def(["y"], 12) },
  ];
  steps = [
    { outputId: "out-1", costUsd: 0.1 },
    { outputId: "out-1", costUsd: 0.2 },
    { outputId: "out-1", costUsd: null },
    { outputId: "out-2", costUsd: 0.05 },
  ];

  const res = await GET(req());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { rows: Row[]; totals: Row };
  assert.deepEqual(
    body.rows.map((r) => [r.outputId, r.requestRef, r.editKinds, r.timeToApprovalMs, r.costUsd, r.rejectReason]),
    [
      ["out-3", "R-0002", ["wording"], null, 0, "Wrong output"],
      ["out-2", "R-0002", [], 3600000, 0.05, null],
      ["out-1", "R-0001", ["size", "wording"], 5400000, 0.3, null],
    ],
  );
  assert.deepEqual(body.totals, {
    requests: 2,
    outputs: 3,
    firstTryRate: 0.5,
    medianDrafts: 2,
    totalCostUsd: 0.35,
  });
  assert.equal(lastTake, 50);
});

test("take is passed through and clamped; junk is a 400", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/signals/route");
  await GET(req("?take=5"));
  assert.equal(lastTake, 5);
  await GET(req("?take=100000"));
  assert.equal(lastTake, 200);
  assert.equal((await GET(req("?take=lots"))).status, 400);
});

test("a missing table reads as an empty table with zero totals", async () => {
  const { GET } = await import("../src/app/api/admin/change-requests/signals/route");
  tableMissing = true;
  const res = await GET(req());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    rows: [],
    totals: { requests: 0, outputs: 0, firstTryRate: null, medianDrafts: null, totalCostUsd: 0 },
  });
});
