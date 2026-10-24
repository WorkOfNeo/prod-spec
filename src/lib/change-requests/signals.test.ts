import { test, before } from "node:test";
import assert from "node:assert/strict";
import { applyLayoutOps, type LayoutOp } from "@/lib/output-layouts/ops";
import { LayoutDefSchema, type LayoutDef } from "@/lib/output-layouts/schema";

// Learning signals: edit-kind bucketing over real describeLayoutChanges
// output, per-output rows and the table totals. Synthetic 50×60 mm sticker on
// a 1 mm grid, as in ops.test.ts.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let s: typeof import("./signals");
before(async () => {
  s = await import("./signals");
});

function sticker(): LayoutDef {
  return LayoutDefSchema.parse({
    pages: [
      {
        id: "p1",
        widthMm: 50,
        heightMm: 60,
        gridCols: 50,
        gridRows: 60,
        blocks: [
          { id: "b-style", rect: { col: 2, row: 2, colSpan: 46, rowSpan: 6 }, fontPt: 9, lines: ["{{styleNumber}}"] },
          { id: "b-size", rect: { col: 2, row: 10, colSpan: 46, rowSpan: 6 }, fontPt: 9, lines: ["SIZE: {{size}}"] },
        ],
      },
    ],
  });
}

function edited(ops: LayoutOp[]): LayoutDef {
  const res = applyLayoutOps(sticker(), ops);
  assert.deepEqual(res.rejected, []);
  return res.def;
}

// ---- buckets --------------------------------------------------------------

test("font size is 'size'; other block props are 'other'", () => {
  const size = edited([{ op: "set_block_props", page: 0, blockId: "b-size", props: { fontPt: 11 } }]);
  assert.deepEqual(s.editKindsBetween(sticker(), size), ["size"]);
  const bold = edited([{ op: "set_block_props", page: 0, blockId: "b-size", props: { bold: true } }]);
  assert.deepEqual(s.editKindsBetween(sticker(), bold), ["other"]);
});

test("move and resize are 'position'", () => {
  const moved = edited([
    { op: "set_rect", page: 0, blockId: "b-size", rect: { col: 4, row: 12, colSpan: 46, rowSpan: 6 } },
  ]);
  assert.deepEqual(s.editKindsBetween(sticker(), moved), ["position"]);
  const resized = edited([
    { op: "set_rect", page: 0, blockId: "b-size", rect: { col: 2, row: 10, colSpan: 30, rowSpan: 8 } },
  ]);
  assert.deepEqual(s.editKindsBetween(sticker(), resized), ["position"]);
});

test("line text is 'wording'; adding or removing a block is 'scope'", () => {
  const worded = edited([
    { op: "edit_line", page: 0, blockId: "b-size", line: 0, oldText: "SIZE: {{size}}", newText: "STR: {{size}}" },
  ]);
  assert.deepEqual(s.editKindsBetween(sticker(), worded), ["wording"]);
  const added = edited([
    { op: "add_block", page: 0, block: { rect: { col: 7, row: 42, colSpan: 27, rowSpan: 4 }, lines: ["PCS"] } },
  ]);
  assert.deepEqual(s.editKindsBetween(sticker(), added), ["scope"]);
  const removed = edited([{ op: "remove_block", page: 0, blockId: "b-style" }]);
  assert.deepEqual(s.editKindsBetween(sticker(), removed), ["scope"]);
});

test("several edits → distinct kinds in a fixed order", () => {
  const def = edited([
    { op: "edit_line", page: 0, blockId: "b-size", line: 0, oldText: "SIZE: {{size}}", newText: "STR: {{size}}" },
    { op: "set_block_props", page: 0, blockId: "b-style", props: { fontPt: 12 } },
    { op: "set_block_props", page: 0, blockId: "b-size", props: { fontPt: 10 } },
  ]);
  assert.deepEqual(s.editKindsBetween(sticker(), def), ["size", "wording"]);
});

test("identical or unreadable definitions contribute nothing", () => {
  assert.deepEqual(s.editKindsBetween(sticker(), sticker()), []);
  assert.deepEqual(s.editKindsBetween(null, sticker()), []);
  assert.deepEqual(s.editKindsBetween(sticker(), { nope: true }), []);
});

test("page-level changes are 'other'", () => {
  assert.equal(s.editKindOf({ kind: "page", page: 0, summary: "Page size 50×60 → 50×70 mm" }), "other");
});

// ---- per output -----------------------------------------------------------

test("only revisions with a parent count; the first draft is not a correction", () => {
  const v1 = sticker();
  const v2 = edited([{ op: "set_block_props", page: 0, blockId: "b-size", props: { fontPt: 11 } }]);
  const v3 = edited([
    { op: "set_block_props", page: 0, blockId: "b-size", props: { fontPt: 11 } },
    { op: "set_rect", page: 0, blockId: "b-style", rect: { col: 3, row: 2, colSpan: 46, rowSpan: 6 } },
  ]);
  const revisions = [
    { id: "r1", parentRevisionId: null, definition: v1 },
    { id: "r2", parentRevisionId: "r1", definition: v2 },
    { id: "r3", parentRevisionId: "r2", definition: v3 },
  ];
  const defs = new Map<string, unknown>(revisions.map((r) => [r.id, r.definition]));
  assert.deepEqual(s.outputEditKinds(revisions, defs), ["size", "position"]);
  assert.deepEqual(s.outputEditKinds(revisions.slice(0, 1), defs), []);
  // A parent we couldn't load is skipped, not guessed.
  assert.deepEqual(s.outputEditKinds([{ id: "r9", parentRevisionId: "gone", definition: v2 }], defs), []);
});

const output = (over: Partial<import("./signals").OutputForSignals> = {}) => ({
  id: "out-1",
  requestId: "req-1",
  label: "Polybag sticker",
  status: "PUBLISHED",
  draftCount: 1,
  firstTryApproved: true as boolean | null,
  approvedAt: new Date("2026-10-24T12:30:00Z") as Date | null,
  createdAt: new Date("2026-10-24T10:00:00Z"),
  rejectReason: null as string | null,
  request: { number: 7 },
  ...over,
});

test("row: request ref, time to approval, rounded cost", () => {
  const row = s.buildOutputSignal(output(), ["wording"], 0.1 + 0.2);
  assert.equal(row.requestRef, "R-0007");
  assert.equal(row.timeToApprovalMs, 2.5 * 3600 * 1000);
  assert.equal(row.costUsd, 0.3);
  assert.deepEqual(row.editKinds, ["wording"]);
  assert.equal(row.createdAt, "2026-10-24T10:00:00.000Z");
  const open = s.buildOutputSignal(output({ approvedAt: null, firstTryApproved: null, status: "IN_REVIEW" }), [], 0);
  assert.equal(open.timeToApprovalMs, null);
});

// ---- totals ---------------------------------------------------------------

test("median of nothing is null; odd and even counts", () => {
  assert.equal(s.median([]), null);
  assert.equal(s.median([3, 1, 2]), 2);
  assert.equal(s.median([4, 1, 3, 2]), 2.5);
});

test("totals: distinct requests, first-try rate over decided outputs, median drafts over drafted ones", () => {
  const rows = [
    s.buildOutputSignal(output({ id: "o1", requestId: "req-1", draftCount: 1, firstTryApproved: true }), [], 0.5),
    s.buildOutputSignal(output({ id: "o2", requestId: "req-1", draftCount: 3, firstTryApproved: false }), [], 1.25),
    s.buildOutputSignal(
      output({ id: "o3", requestId: "req-2", draftCount: 2, firstTryApproved: null, approvedAt: null }),
      [],
      0.25,
    ),
    // No draft yet (e.g. waiting on code): counts as a request, not in the median.
    s.buildOutputSignal(
      output({ id: "o4", requestId: "req-3", draftCount: 0, firstTryApproved: null, approvedAt: null }),
      [],
      0,
    ),
  ];
  assert.deepEqual(s.signalTotals(rows), {
    requests: 3,
    outputs: 4,
    firstTryRate: 0.5,
    medianDrafts: 2,
    totalCostUsd: 2,
  });
});

test("totals of an empty table", () => {
  assert.deepEqual(s.signalTotals([]), {
    requests: 0,
    outputs: 0,
    firstTryRate: null,
    medianDrafts: null,
    totalCostUsd: 0,
  });
});
