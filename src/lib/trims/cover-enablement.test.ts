import { test } from "node:test";
import assert from "node:assert/strict";
import { trimsEnabledFor } from "./cover-enablement";

// The composition rule is three lines and everything downstream trusts it, so
// every combination is pinned here rather than inferred from the two callers.
//
// The property that matters is that the per-spec column can only ever turn the
// layer ON. If it could turn it off, flipping the global would become a
// per-spec audit, and un-flipping it would strand specs somebody had switched
// on deliberately.

test("both off ⇒ off — the state every cover is in today", () => {
  assert.equal(trimsEnabledFor({ globalEnabled: false, specEnabled: false }), false);
});

test("the global alone turns it on, for specs that never opted in", () => {
  assert.equal(trimsEnabledFor({ globalEnabled: true, specEnabled: false }), true);
});

test("a spec alone turns it on, while the global stays off", () => {
  assert.equal(trimsEnabledFor({ globalEnabled: false, specEnabled: true }), true);
});

test("a spec ticked before the global flip keeps working after it", () => {
  assert.equal(trimsEnabledFor({ globalEnabled: true, specEnabled: true }), true);
});

test("a spec can never turn the global OFF — there is no override arm", () => {
  // The whole reason the rule is OR: an AND or an override would let one spec's
  // stale flag suppress a release decision made for the whole book.
  assert.equal(trimsEnabledFor({ globalEnabled: true, specEnabled: false }), true);
});

test("an absent spec flag reads as off, never as undefined-y truth", () => {
  // A style with no prod spec, or a spec row that predates the column: both
  // must land on "off", which is what covers already print.
  assert.equal(trimsEnabledFor({ globalEnabled: false, specEnabled: null }), false);
  assert.equal(trimsEnabledFor({ globalEnabled: false, specEnabled: undefined }), false);
});

test("only a literal true counts — no coercion", () => {
  // Guards against a JSON round trip handing us "false" or 0 and the strict
  // comparison quietly doing the right thing where a truthy check would not.
  assert.equal(trimsEnabledFor({ globalEnabled: false, specEnabled: "true" as unknown as boolean }), false);
  assert.equal(trimsEnabledFor({ globalEnabled: false, specEnabled: 1 as unknown as boolean }), false);
});
