import { test } from "node:test";
import assert from "node:assert/strict";
import { canReview, isAdmin } from "./roles";

// Pure predicate tests for the API role gates — no session, DB, or Next
// runtime required (see the note in roles.ts). The end-to-end behaviour of
// these predicates inside the actual route handlers is covered separately by
// tests/admin-role-gate.test.ts.

test("canReview gates to ADMIN and REVIEWER only", () => {
  assert.equal(canReview("ADMIN"), true);
  assert.equal(canReview("REVIEWER"), true);
  assert.equal(canReview(null), false);
  assert.equal(canReview("SUPPLIER" as never), false);
});

test("isAdmin gates to ADMIN only — REVIEWERs are refused", () => {
  assert.equal(isAdmin("ADMIN"), true);
  assert.equal(isAdmin("REVIEWER"), false);
  assert.equal(isAdmin(null), false);
  assert.equal(isAdmin("SUPPLIER" as never), false);
});
