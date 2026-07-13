import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOutput, type BaseAssetState } from "./rerun-buckets";

// A base with no asset at all — from a never-generated / newly-added output.
const NONE: BaseAssetState | undefined = undefined;

function state(patch: Partial<BaseAssetState>): BaseAssetState {
  return { hasAsset: true, hasRejected: false, hasPending: false, configKey: null, ...patch };
}

test("classifyOutput — no asset is 'missing'", () => {
  assert.equal(classifyOutput(NONE, "k"), "missing");
  assert.equal(classifyOutput(state({ hasAsset: false }), "k"), "missing");
});

test("classifyOutput — a rejected latest asset is 'rejected' (regardless of key)", () => {
  assert.equal(classifyOutput(state({ hasRejected: true, configKey: "old" }), "new"), "rejected");
  assert.equal(classifyOutput(state({ hasRejected: true, hasPending: true }), "new"), "rejected");
});

test("classifyOutput — APPROVED (no pending doc) is never re-run, even when the config changed", () => {
  // The user's explicit rule: approved work is left alone. A fully-approved base
  // has no pending doc, so a key mismatch does NOT make it 'changed'.
  assert.equal(classifyOutput(state({ hasPending: false, configKey: "old" }), "new"), "ok");
});

test("classifyOutput — awaiting review + config changed is 'changed'", () => {
  assert.equal(classifyOutput(state({ hasPending: true, configKey: "old" }), "new"), "changed");
});

test("classifyOutput — awaiting review + config unchanged is 'ok' (no churn)", () => {
  assert.equal(classifyOutput(state({ hasPending: true, configKey: "same" }), "same"), "ok");
});

test("classifyOutput — a null key on either side is never 'changed' (unknown ⇒ safe)", () => {
  // Pre-db:deploy / un-backfilled asset: stored key null.
  assert.equal(classifyOutput(state({ hasPending: true, configKey: null }), "new"), "ok");
  // Output no longer in the spec: current key null.
  assert.equal(classifyOutput(state({ hasPending: true, configKey: "old" }), null), "ok");
});
