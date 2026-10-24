// enqueueBulkRun stamps every job it creates with the trigger the caller names:
// MANUAL_BULK by default (the /styles and per-ProdSpec bulk actions, which pass
// nothing and must behave exactly as before), CHANGE_REQUEST for the scoped
// rerun after an approved change request — the value the runner keys the
// silent cover re-arm on.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

let createdJobs: Array<Record<string, unknown>> = [];
const triggerRunner = mock.fn(async () => {});

before(() => {
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        style: {
          // Every requested style carries a PO and clears the (absent) cutoff.
          findMany: async (args: { where: { id: { in: string[] } } }) =>
            args.where.id.in.map((id, i) => ({ id, poNumber: `PO-000${i}`, poSeq: 70000 + i })),
          updateMany: async () => ({ count: 0 }),
        },
        job: {
          createMany: async (args: { data: Array<Record<string, unknown>> }) => {
            createdJobs.push(...args.data);
            return { count: args.data.length };
          },
        },
        bulkRunBatch: { create: async () => ({ id: "bogus-batch" }) },
      },
    },
  });
  mock.module("@/lib/settings/app-settings", {
    namedExports: { getGenerationMinPo: async () => null, getDoneGroupPoCutoff: async () => null },
  });
  mock.module("@/lib/queue/trigger", { namedExports: { triggerRunner } });
});

beforeEach(() => {
  createdJobs = [];
  triggerRunner.mock.resetCalls();
});

const RUNNABLE = [
  { id: "bogus-style-1", prodSpecId: "bogus-spec", variantKeys: ["layout:bogus-id"] },
  { id: "bogus-style-2", prodSpecId: "bogus-spec", variantKeys: ["layout:bogus-id"] },
];
const USER = { id: "admin-1", email: "admin@example.com" };

test("defaults to MANUAL_BULK, as every existing caller expects", async () => {
  const { enqueueBulkRun } = await import("@/lib/queue/bulk-run");
  const res = await enqueueBulkRun({ runnable: RUNNABLE, label: "Run all", user: USER });

  assert.equal(res.enqueued, 2);
  assert.deepEqual(
    createdJobs.map((j) => j.triggerSource),
    ["MANUAL_BULK", "MANUAL_BULK"],
  );
  assert.equal(triggerRunner.mock.callCount(), 1);
});

test("passes CHANGE_REQUEST through to every created job, scoped as given", async () => {
  const { enqueueBulkRun } = await import("@/lib/queue/bulk-run");
  await enqueueBulkRun({
    runnable: RUNNABLE,
    label: "R-0001 rerun",
    user: USER,
    triggerSource: "CHANGE_REQUEST",
  });

  assert.deepEqual(
    createdJobs.map((j) => j.triggerSource),
    ["CHANGE_REQUEST", "CHANGE_REQUEST"],
  );
  assert.deepEqual(createdJobs[0]?.variantKeys, ["layout:bogus-id"]);
});

test("passes CHANGE_REQUEST_APPROVED through for the rerun of approved documents", async () => {
  const { enqueueBulkRun } = await import("@/lib/queue/bulk-run");
  await enqueueBulkRun({
    runnable: RUNNABLE.slice(0, 1),
    label: "R-0001 approved",
    user: USER,
    triggerSource: "CHANGE_REQUEST_APPROVED",
  });
  assert.deepEqual(
    createdJobs.map((j) => j.triggerSource),
    ["CHANGE_REQUEST_APPROVED"],
  );
});
