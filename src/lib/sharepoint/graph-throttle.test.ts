import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  noteGraphFailure,
  noteGraphSuccess,
  graphThrottleWaitMs,
  graphThrottleStreak,
  resetGraphThrottle,
} from "./graph-throttle";

beforeEach(() => resetGraphThrottle());

test("an ordinary failure is not a throttle — a 404 must not slow a sweep down", () => {
  noteGraphFailure({ statusCode: 404 });
  assert.equal(graphThrottleWaitMs(), 0);
  assert.equal(graphThrottleStreak(), 0);
});

test("a 429 asks the caller to wait", () => {
  noteGraphFailure({ statusCode: 429 });
  assert.ok(graphThrottleWaitMs() > 0);
  assert.equal(graphThrottleStreak(), 1);
});

test("Graph's own Retry-After wins over our guess", () => {
  noteGraphFailure({ statusCode: 429, headers: { "retry-after": "30" } });
  const wait = graphThrottleWaitMs();
  assert.ok(wait > 25_000 && wait <= 30_000, `expected ~30s, got ${wait}`);
});

test("a nonsense Retry-After falls back to the exponential guess rather than stalling", () => {
  noteGraphFailure({ statusCode: 429, headers: { "retry-after": "Wed, 21 Oct 2099 07:28:00 GMT" } });
  const wait = graphThrottleWaitMs();
  assert.ok(wait > 0 && wait <= 120_000, `a parsed date must never strand a sweep: ${wait}`);
});

test("throttles in a row back off further, and are capped", () => {
  for (let i = 0; i < 12; i++) noteGraphFailure({ statusCode: 429 });
  assert.equal(graphThrottleStreak(), 12);
  assert.ok(graphThrottleWaitMs() <= 120_000, "one bad minute must not stall an overnight run forever");
});

test("503 and 504 count as back off — hammering a failing service is the same mistake", () => {
  noteGraphFailure({ statusCode: 503 });
  assert.equal(graphThrottleStreak(), 1);
  noteGraphFailure({ status: 504 });
  assert.equal(graphThrottleStreak(), 2);
});

test("a clean pass resets the streak, so the next throttle starts low again", () => {
  noteGraphFailure({ statusCode: 429 });
  noteGraphFailure({ statusCode: 429 });
  noteGraphSuccess();
  assert.equal(graphThrottleStreak(), 0);
});

test("something that is not an error object at all is ignored", () => {
  noteGraphFailure(undefined);
  noteGraphFailure("boom");
  assert.equal(graphThrottleWaitMs(), 0);
});
