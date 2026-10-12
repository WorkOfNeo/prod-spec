import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePoll } from "./poll-schedule";

const MIN = 60_000;

test("the first ask in a visible tab runs and comes back a full interval later", () => {
  assert.deepEqual(decidePoll({ now: 5, lastRunAt: null, intervalMs: MIN, hidden: false }), {
    run: true,
    nextInMs: MIN,
  });
});

test("a hidden tab never runs and arms nothing — even if it has never run", () => {
  assert.deepEqual(decidePoll({ now: 5, lastRunAt: null, intervalMs: MIN, hidden: true }), {
    run: false,
    nextInMs: null,
  });
  assert.deepEqual(decidePoll({ now: 10 * MIN, lastRunAt: 0, intervalMs: MIN, hidden: true }), {
    run: false,
    nextInMs: null,
  });
});

test("the timer firing on schedule runs", () => {
  assert.deepEqual(decidePoll({ now: MIN, lastRunAt: 0, intervalMs: MIN, hidden: false }), {
    run: true,
    nextInMs: MIN,
  });
});

test("turning visible after a long absence runs at once", () => {
  assert.deepEqual(decidePoll({ now: 7 * MIN, lastRunAt: 0, intervalMs: MIN, hidden: false }), {
    run: true,
    nextInMs: MIN,
  });
});

test("turning visible soon after a run waits out the rest of the interval", () => {
  assert.deepEqual(decidePoll({ now: 20_000, lastRunAt: 0, intervalMs: MIN, hidden: false }), {
    run: false,
    nextInMs: 40_000,
  });
});

test("a timer that fires a hair early re-arms for the remainder instead of skipping a beat", () => {
  assert.deepEqual(decidePoll({ now: MIN - 1, lastRunAt: 0, intervalMs: MIN, hidden: false }), {
    run: false,
    nextInMs: 1,
  });
});

test("a clock that went backwards is treated as due, not parked", () => {
  assert.deepEqual(decidePoll({ now: 0, lastRunAt: 5 * MIN, intervalMs: MIN, hidden: false }), {
    run: true,
    nextInMs: MIN,
  });
});

test("by default turning visible soon after a run does not force one", () => {
  assert.deepEqual(
    decidePoll({ now: 20_000, lastRunAt: 0, intervalMs: MIN, hidden: false, becameVisible: true }),
    { run: false, nextInMs: 40_000 },
  );
});

test("pauseWhileHidden: false keeps the interval in a hidden tab", () => {
  const keepGoing = { intervalMs: MIN, hidden: true, pauseWhileHidden: false };
  assert.deepEqual(decidePoll({ ...keepGoing, now: 5, lastRunAt: null }), { run: true, nextInMs: MIN });
  assert.deepEqual(decidePoll({ ...keepGoing, now: MIN, lastRunAt: 0 }), { run: true, nextInMs: MIN });
  assert.deepEqual(decidePoll({ ...keepGoing, now: 20_000, lastRunAt: 0 }), { run: false, nextInMs: 40_000 });
});

test("pauseWhileHidden: false runs at once on turning visible, however recent the last run", () => {
  assert.deepEqual(
    decidePoll({
      now: 20_000,
      lastRunAt: 0,
      intervalMs: MIN,
      hidden: false,
      pauseWhileHidden: false,
      becameVisible: true,
    }),
    { run: true, nextInMs: MIN },
  );
});

test("as a throttle: one run per window, and a skipped ask learns when the window ends", () => {
  const w = 30_000;
  let lastRunAt: number | null = null;
  const runs: number[] = [];
  // Focus events at these times.
  for (const now of [0, 1_000, 5_000, 29_999, 30_000, 31_000, 90_000]) {
    const d = decidePoll({ now, lastRunAt, intervalMs: w, hidden: false });
    if (d.run) {
      lastRunAt = now;
      runs.push(now);
    }
  }
  assert.deepEqual(runs, [0, 30_000, 90_000]);
  assert.equal(decidePoll({ now: 95_000, lastRunAt: 90_000, intervalMs: w, hidden: false }).nextInMs, 25_000);
});
