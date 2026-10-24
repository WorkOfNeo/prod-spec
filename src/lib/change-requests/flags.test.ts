import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { changeRequestsEnabled } from "./flags";

// Default OFF: anything but the exact string "true" keeps the feature inert.

const ORIGINAL = process.env.CHANGE_REQUESTS_ENABLED;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CHANGE_REQUESTS_ENABLED;
  else process.env.CHANGE_REQUESTS_ENABLED = ORIGINAL;
});

test("off when unset", () => {
  delete process.env.CHANGE_REQUESTS_ENABLED;
  assert.equal(changeRequestsEnabled(), false);
});

test("off for anything but exactly 'true'", () => {
  for (const v of ["", "1", "TRUE", "yes", "false"]) {
    process.env.CHANGE_REQUESTS_ENABLED = v;
    assert.equal(changeRequestsEnabled(), false, `value ${JSON.stringify(v)}`);
  }
});

test("on for 'true'", () => {
  process.env.CHANGE_REQUESTS_ENABLED = "true";
  assert.equal(changeRequestsEnabled(), true);
});
