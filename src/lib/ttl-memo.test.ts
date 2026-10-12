import { test } from "node:test";
import assert from "node:assert/strict";
import { ttlMemo } from "./ttl-memo";

// A fake clock so expiry is exact rather than a sleep.
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("within the TTL the loader runs once", async () => {
  const c = clock();
  let calls = 0;
  const get = ttlMemo(async () => ++calls, 60_000, c.now);
  assert.equal(await get(), 1);
  c.advance(59_999);
  assert.equal(await get(), 1);
  assert.equal(calls, 1);
});

test("once the TTL has passed the next caller gets a fresh value", async () => {
  const c = clock();
  let calls = 0;
  const get = ttlMemo(async () => ++calls, 60_000, c.now);
  assert.equal(await get(), 1);
  c.advance(60_000);
  assert.equal(await get(), 2);
  assert.equal(calls, 2);
});

test("the TTL runs from when the computation started, not when it finished", async () => {
  const c = clock();
  let calls = 0;
  const get = ttlMemo(
    async () => {
      calls += 1;
      c.advance(10_000); // a slow scan
      return calls;
    },
    60_000,
    c.now,
  );
  assert.equal(await get(), 1);
  c.advance(50_000); // 60s after the first read began
  assert.equal(await get(), 2);
});

test("concurrent callers share one in-flight computation", async () => {
  const c = clock();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const get = ttlMemo(
    async () => {
      calls += 1;
      await gate;
      return calls;
    },
    60_000,
    c.now,
  );
  const all = Promise.all([get(), get(), get()]);
  release();
  assert.deepEqual(await all, [1, 1, 1]);
  assert.equal(calls, 1);
});

test("an expired value is not served while its refresh is running", async () => {
  const c = clock();
  let calls = 0;
  const get = ttlMemo(async () => ++calls, 60_000, c.now);
  await get();
  c.advance(60_000);
  const [a, b] = await Promise.all([get(), get()]);
  assert.deepEqual([a, b], [2, 2]);
  assert.equal(calls, 2);
});

test("a failure is shared by its waiters but never remembered", async () => {
  const c = clock();
  let calls = 0;
  const get = ttlMemo(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return "ok";
    },
    60_000,
    c.now,
  );
  const results = await Promise.allSettled([get(), get()]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["rejected", "rejected"],
  );
  assert.equal(calls, 1);
  assert.equal(await get(), "ok");
  assert.equal(calls, 2);
});

test("a loader that throws synchronously still rejects rather than throwing at the caller", async () => {
  const get = ttlMemo<number>(() => {
    throw new Error("boom");
  }, 60_000);
  await assert.rejects(() => get(), /boom/);
});
