// The request roll-up (src/lib/change-requests/store.ts rollUpRequestStatus)
// runs in one transaction that locks the request row FIRST, then reads the
// outputs and writes the status — so two outputs settling at once can't
// leave a summary computed from the other one's old status. The db is mocked;
// the test pins the order and the lock statement.
//
// Runs under: node --experimental-test-module-mocks --import tsx --test
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

type Row = Record<string, unknown>;
let calls: Array<{ op: string; args: unknown }>;
let statuses: string[];
let inTransaction = false;

const tx = {
  $queryRaw: async (query: { text: string; values: unknown[] }) => {
    calls.push({ op: "lock", args: query });
    return [{ "?column?": 1 }];
  },
  changeRequestOutput: {
    findMany: async (args: Row) => {
      calls.push({ op: "outputs", args });
      return statuses.map((status) => ({ status }));
    },
  },
  changeRequest: {
    update: async (args: Row) => {
      calls.push({ op: "update", args });
      return {};
    },
  },
};

before(() => {
  mock.module("@/lib/db", {
    namedExports: {
      db: {
        $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
          inTransaction = true;
          try {
            return await fn(tx);
          } finally {
            inTransaction = false;
          }
        },
        // Reads or writes outside the transaction would not be under the lock.
        changeRequestOutput: {
          findMany: async () => {
            throw new Error("read outside the transaction");
          },
        },
        changeRequest: {
          update: async () => {
            throw new Error("write outside the transaction");
          },
        },
      },
    },
  });
});

beforeEach(() => {
  calls = [];
  statuses = [];
});

test("locks the request row, then reads the outputs, then writes the summary — all in one transaction", async () => {
  const { rollUpRequestStatus } = await import("@/lib/change-requests/store");
  statuses = ["PUBLISHED", "IN_REVIEW"];
  const status = await rollUpRequestStatus("req-1");
  assert.equal(status, "IN_REVIEW");
  assert.equal(inTransaction, false);
  assert.deepEqual(
    calls.map((c) => c.op),
    ["lock", "outputs", "update"],
  );
  const lock = calls[0].args as { text: string; values: unknown[] };
  assert.equal(lock.text, "SELECT 1 FROM change_requests WHERE id = $1 FOR UPDATE");
  assert.deepEqual(lock.values, ["req-1"]);
  assert.deepEqual(calls[1].args, { where: { requestId: "req-1" }, select: { status: true } });
  assert.deepEqual(calls[2].args, { where: { id: "req-1" }, data: { status: "IN_REVIEW" } });
});

test("settles on DONE once nothing is open", async () => {
  const { rollUpRequestStatus } = await import("@/lib/change-requests/store");
  statuses = ["PUBLISHED", "REJECTED"];
  assert.equal(await rollUpRequestStatus("req-2"), "DONE");
  assert.deepEqual((calls[2].args as Row).data, { status: "DONE" });
});
