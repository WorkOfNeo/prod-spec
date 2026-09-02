import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency, STYLE_CONCURRENCY } from "./style-pool";

// A deferred promise, so a test can decide the order work FINISHES in.
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("results come back in input order even when the work finishes backwards", async () => {
  const gates = [0, 1, 2, 3, 4].map(() => deferred<void>());
  const started: number[] = [];

  const run = mapWithConcurrency([0, 1, 2, 3, 4], 5, async (n) => {
    started.push(n);
    await gates[n].promise;
    return `r${n}`;
  });

  // Let all five start, then finish them in reverse.
  await Promise.resolve();
  for (let i = 4; i >= 0; i--) gates[i].resolve();

  assert.deepEqual(await run, ["r0", "r1", "r2", "r3", "r4"]);
  assert.deepEqual(started, [0, 1, 2, 3, 4], "work is still CLAIMED in input order");
});

test("never more than `limit` calls are in flight at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);

  const out = await mapWithConcurrency(items, 5, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    // Two turns of the microtask queue, so overlap is real rather than assumed.
    await Promise.resolve();
    await Promise.resolve();
    inFlight--;
    return n * 2;
  });

  assert.equal(peak, 5, "the pool is saturated — the concurrency is real, not nominal");
  assert.deepEqual(out, items.map((n) => n * 2));
});

test("the pool is the reason it is faster: 20 slow items take 4 waves, not 20", async () => {
  const waves: number[][] = [];
  let current: number[] = [];
  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 5, async (n) => {
    current.push(n);
    if (current.length === 5) {
      waves.push(current);
      current = [];
    }
    await new Promise((r) => setTimeout(r, 1));
  });
  assert.equal(waves.length, 4, "20 items at width 5 is four overlapping groups");
});

test("fewer items than the limit does not spawn idle workers, and an empty list is fine", async () => {
  let calls = 0;
  const two = await mapWithConcurrency([1, 2], 5, async (n) => {
    calls++;
    return n;
  });
  assert.deepEqual(two, [1, 2]);
  assert.equal(calls, 2);

  assert.deepEqual(await mapWithConcurrency([], 5, async () => "never"), []);
});

test("a limit below 1 still makes progress rather than hanging", async () => {
  assert.deepEqual(await mapWithConcurrency([1, 2, 3], 0, async (n) => n + 1), [2, 3, 4]);
});

test("a rejection propagates — it is not silently turned into a hole in the results", async () => {
  await assert.rejects(
    () =>
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("style unreadable");
        return n;
      }),
    /style unreadable/,
  );
});

test("the configured width stays small enough for a proxied connection pool", () => {
  assert.ok(STYLE_CONCURRENCY >= 2 && STYLE_CONCURRENCY <= 8);
});
