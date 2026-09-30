import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dueStyleIds,
  formatLedgerEntry,
  MAX_REGEN_ATTEMPTS,
  parseLedgerEntry,
  rearmFailed,
  withoutDue,
} from "./cover-regen-ledger";

const now = Date.parse("2026-07-16T12:00:00.000Z");
const past = new Date(now - 1000).toISOString();
const future = new Date(now + 5000).toISOString();

test("dueStyleIds returns only styles whose window has elapsed", () => {
  const q = { a: past, b: future, c: past };
  assert.deepEqual(dueStyleIds(q, now).sort(), ["a", "c"]);
});

test("dueStyleIds treats a corrupt timestamp as due (never wedges)", () => {
  const q = { a: "not-a-date", b: future };
  assert.deepEqual(dueStyleIds(q, now), ["a"]);
});

test("dueStyleIds is empty when nothing is due", () => {
  assert.deepEqual(dueStyleIds({ b: future }, now), []);
});

test("withoutDue keeps only the not-yet-due entries (the claim)", () => {
  const q = { a: past, b: future, c: past };
  assert.deepEqual(withoutDue(q, now), { b: future });
});

test("withoutDue drops corrupt entries too (they were claimed as due)", () => {
  const q = { a: "garbage", b: future };
  assert.deepEqual(withoutDue(q, now), { b: future });
});

test("due + remaining partition the ledger with no overlap or loss", () => {
  const q = { a: past, b: future, c: past, d: future };
  const due = new Set(dueStyleIds(q, now));
  const remaining = new Set(Object.keys(withoutDue(q, now)));
  // every key is in exactly one side
  for (const k of Object.keys(q)) {
    assert.equal(due.has(k) !== remaining.has(k), true, `key ${k} must be in exactly one partition`);
  }
});

test("a retry entry (<iso>#<n>) is due and claimed exactly like a plain one", () => {
  const q = { a: formatLedgerEntry(past, 2), b: formatLedgerEntry(future, 1) };
  assert.deepEqual(dueStyleIds(q, now), ["a"]);
  assert.deepEqual(withoutDue(q, now), { b: q.b });
});

test("parseLedgerEntry reads plain entries as attempt 0", () => {
  assert.deepEqual(parseLedgerEntry(past), { dueAt: past, attempts: 0 });
  assert.deepEqual(parseLedgerEntry(`${past}#3`), { dueAt: past, attempts: 3 });
});

test("rearmFailed puts a failed render back with a backoff and a bumped count", () => {
  const { queue, gaveUp } = rearmFailed({}, ["a"], { a: past }, now);
  assert.deepEqual(gaveUp, []);
  const entry = parseLedgerEntry(queue.a);
  assert.equal(entry.attempts, 1);
  assert.ok(Date.parse(entry.dueAt) > now, "retry must be in the future");
});

test("rearmFailed leaves a style alone if fresh demand was stamped meanwhile", () => {
  const fresh = future;
  const { queue } = rearmFailed({ a: fresh }, ["a"], { a: `${past}#2` }, now);
  assert.equal(queue.a, fresh);
});

test("rearmFailed gives up after MAX_REGEN_ATTEMPTS instead of retrying forever", () => {
  const claimed = { a: formatLedgerEntry(past, MAX_REGEN_ATTEMPTS - 1) };
  const { queue, gaveUp } = rearmFailed({}, ["a"], claimed, now);
  assert.deepEqual(gaveUp, ["a"]);
  assert.equal("a" in queue, false);
});
