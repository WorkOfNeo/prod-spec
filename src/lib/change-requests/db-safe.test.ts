import { test } from "node:test";
import assert from "node:assert/strict";
import { isMissingTable, orEmpty } from "./db-safe";

// Readers degrade on a not-yet-deployed table or column, and ONLY on that: any
// other failure must still surface.

test("isMissingTable recognises P2021 and P2022 only", () => {
  assert.equal(isMissingTable({ code: "P2021" }), true);
  assert.equal(isMissingTable({ code: "P2022" }), true);
  assert.equal(isMissingTable({ code: "P2002" }), false);
  assert.equal(isMissingTable(new Error("boom")), false);
  assert.equal(isMissingTable(null), false);
  assert.equal(isMissingTable("P2021"), false);
});

test("orEmpty returns the result when the read succeeds", async () => {
  assert.deepEqual(await orEmpty(Promise.resolve([1, 2]), []), [1, 2]);
});

test("orEmpty returns the fallback on a missing table", async () => {
  const err = Object.assign(new Error("The table does not exist"), { code: "P2021" });
  assert.deepEqual(await orEmpty(Promise.reject(err), [] as number[]), []);
  assert.equal(await orEmpty(Promise.reject({ code: "P2022" }), null), null);
});

test("orEmpty rethrows every other error", async () => {
  const err = Object.assign(new Error("connection refused"), { code: "P1001" });
  await assert.rejects(orEmpty(Promise.reject(err), []), /connection refused/);
});
