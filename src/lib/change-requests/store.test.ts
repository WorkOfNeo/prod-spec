import { test, before } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let rollUpStatus: typeof import("./store").rollUpStatus;
before(async () => {
  ({ rollUpStatus } = await import("./store"));
});

test("a request with no outputs is NEW", () => {
  assert.equal(rollUpStatus([]), "NEW");
});

test("whoever has to act first wins: agent, then admin, then requester, then developer", () => {
  assert.equal(rollUpStatus(["IN_REVIEW", "WORKING", "NEEDS_CODE"]), "WORKING");
  assert.equal(rollUpStatus(["NEEDS_CODE", "IN_REVIEW"]), "IN_REVIEW");
  assert.equal(rollUpStatus(["NEEDS_INFO", "NEEDS_CODE"]), "NEEDS_INFO");
  assert.equal(rollUpStatus(["PUBLISHED", "NEEDS_CODE"]), "NEEDS_CODE");
  assert.equal(rollUpStatus(["PUBLISHED", "NEW"]), "NEW");
});

test("a failed run needs the admin, like a draft waiting for review", () => {
  assert.equal(rollUpStatus(["PUBLISHED", "FAILED"]), "IN_REVIEW");
});

test("settled requests: anything shipped is DONE, all rejected is REJECTED", () => {
  assert.equal(rollUpStatus(["PUBLISHED", "REJECTED"]), "DONE");
  assert.equal(rollUpStatus(["APPROVED"]), "DONE");
  assert.equal(rollUpStatus(["REJECTED", "REJECTED"]), "REJECTED");
});
