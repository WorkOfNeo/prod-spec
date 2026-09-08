import { test } from "node:test";
import assert from "node:assert/strict";
import { withRunCache, runCached, inRunCache } from "./run-cache";

// The properties the checks pass depends on. The dangerous one is the LAST:
// with no scope open the wrapper must be invisible, because every loader it
// wraps is shared with the runner, the verify sweep and the delivery ledger.

test("with no scope open, the loader runs every time", async () => {
  let calls = 0;
  const load = async () => ++calls;
  assert.equal(await runCached("k", load), 1);
  assert.equal(await runCached("k", load), 2);
  assert.equal(calls, 2);
  assert.equal(inRunCache(), false);
});

test("inside a scope the same key resolves exactly once", async () => {
  let calls = 0;
  await withRunCache(async () => {
    const load = async () => ++calls;
    assert.equal(await runCached("k", load), 1);
    assert.equal(await runCached("k", load), 1);
    assert.equal(await runCached("other", load), 2);
  });
  assert.equal(calls, 2);
});

test("concurrent callers share one in-flight load rather than racing", async () => {
  let calls = 0;
  await withRunCache(async () => {
    const load = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return calls;
    };
    const [a, b, c] = await Promise.all([
      runCached("k", load),
      runCached("k", load),
      runCached("k", load),
    ]);
    assert.deepEqual([a, b, c], [1, 1, 1]);
  });
  assert.equal(calls, 1);
});

test("a failure is never remembered — the next caller gets a real attempt", async () => {
  let calls = 0;
  await withRunCache(async () => {
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return "ok";
    };
    await assert.rejects(() => runCached("k", load), /transient/);
    assert.equal(await runCached("k", load), "ok");
  });
  assert.equal(calls, 2);
});

test("scopes are isolated — a second check never reads the first one's cache", async () => {
  let calls = 0;
  const load = async () => ++calls;
  assert.equal(await withRunCache(() => runCached("k", load)), 1);
  assert.equal(await withRunCache(() => runCached("k", load)), 2);
});

test("a nested scope gets its own store", async () => {
  let calls = 0;
  const load = async () => ++calls;
  await withRunCache(async () => {
    assert.equal(await runCached("k", load), 1);
    await withRunCache(async () => {
      assert.equal(await runCached("k", load), 2);
    });
    assert.equal(await runCached("k", load), 1);
  });
});

test("the scope survives work handed to a concurrency pool", async () => {
  let calls = 0;
  await withRunCache(async () => {
    const load = async () => ++calls;
    await Promise.all(
      [1, 2, 3, 4, 5].map(async () => {
        await new Promise((r) => setTimeout(r, 1));
        await runCached("k", load);
      }),
    );
  });
  assert.equal(calls, 1);
});
