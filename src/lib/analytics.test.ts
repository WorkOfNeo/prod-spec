import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { track, trackSettled } from "./analytics";

const g = globalThis as { window?: { aos?: (...args: unknown[]) => void } };
let calls: unknown[][];

beforeEach(() => {
  calls = [];
  g.window = { aos: (...args: unknown[]) => void calls.push(args) };
});

afterEach(() => {
  delete g.window;
});

test("track forwards the name and props as an aos track call", () => {
  track("output_approved", { scope: "bulk", count: 3 });
  assert.deepEqual(calls, [["track", "output_approved", { scope: "bulk", count: 3 }]]);
});

test("track is a no-op when the script isn't loaded (no key) or on the server", () => {
  g.window = {};
  assert.doesNotThrow(() => track("output_ignored"));
  delete g.window;
  assert.doesNotThrow(() => track("output_ignored"));
});

test("trackSettled reports the decision that closed the job, and nothing otherwise", () => {
  trackSettled("APPROVED");
  trackSettled("REJECTED");
  trackSettled(undefined);
  assert.deepEqual(calls, [
    ["track", "review_completed", { outcome: "approved" }],
    ["track", "review_completed", { outcome: "rejected" }],
  ]);
});
