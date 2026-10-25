import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { identifyUser, resetUser, track, trackSettled } from "./analytics";

const g = globalThis as { window?: { aos?: (...args: unknown[]) => void } };
let calls: unknown[][];

beforeEach(() => {
  calls = [];
  g.window = { aos: (...args: unknown[]) => void calls.push(args) };
  resetUser();
  calls = [];
});

afterEach(() => {
  delete g.window;
});

test("track forwards the name and props as an aos track call", () => {
  track("output_approved", { scope: "bulk" });
  assert.deepEqual(calls, [["track", "output_approved", { scope: "bulk" }]]);
});

test("identifyUser sends the id + role only, and every later event carries the role", () => {
  identifyUser("user-1", "REVIEWER");
  track("output_rejected", { scope: "single", images: 2 });
  assert.deepEqual(calls, [
    ["identify", "user-1", { role: "REVIEWER" }],
    ["track", "output_rejected", { role: "REVIEWER", scope: "single", images: 2 }],
  ]);
});

test("a user without a role is identified as NONE", () => {
  identifyUser("user-2", null);
  track("output_ignored");
  assert.deepEqual(calls.at(-1), ["track", "output_ignored", { role: "NONE" }]);
});

test("resetUser forgets the user and stops stamping the role", () => {
  identifyUser("user-1", "ADMIN");
  resetUser();
  track("bulk_run_started", { mode: "generate", styles: 4 });
  assert.deepEqual(calls.slice(1), [["reset"], ["track", "bulk_run_started", { mode: "generate", styles: 4 }]]);
});

test("all calls are no-ops when the script isn't loaded (no key) or on the server", () => {
  g.window = {};
  assert.doesNotThrow(() => {
    identifyUser("user-1", "ADMIN");
    track("output_ignored");
    resetUser();
  });
  delete g.window;
  assert.doesNotThrow(() => {
    identifyUser("user-1", "ADMIN");
    track("output_ignored");
    resetUser();
  });
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
