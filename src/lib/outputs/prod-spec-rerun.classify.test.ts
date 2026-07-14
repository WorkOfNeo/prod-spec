import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyOutput, type BaseAssetState } from "./rerun-buckets";

// A base with no asset at all — from a never-generated / newly-added output.
const NONE: BaseAssetState | undefined = undefined;

function state(patch: Partial<BaseAssetState>): BaseAssetState {
  return {
    hasAsset: true,
    hasRejected: false,
    hasPending: false,
    configKey: null,
    contentVersion: null,
    ...patch,
  };
}

// classifyOutput(state, currentKey, currentContentVersion)
test("classifyOutput — no asset is 'missing'", () => {
  assert.equal(classifyOutput(NONE, "k", null), "missing");
  assert.equal(classifyOutput(state({ hasAsset: false }), "k", null), "missing");
});

test("classifyOutput — a rejected latest asset is 'rejected' (regardless of key)", () => {
  assert.equal(classifyOutput(state({ hasRejected: true, configKey: "old" }), "new", null), "rejected");
  assert.equal(classifyOutput(state({ hasRejected: true, hasPending: true }), "new", null), "rejected");
});

test("classifyOutput — APPROVED (no pending doc) is the ONLY skip ('ok'), even when config/layout changed", () => {
  // The user's rule: approved work is left alone. A fully-approved base has no
  // pending doc, so neither a key mismatch nor a layout bump brings it back.
  assert.equal(classifyOutput(state({ hasPending: false, configKey: "old" }), "new", null), "ok");
  assert.equal(classifyOutput(state({ hasPending: false, contentVersion: 1 }), null, 2), "ok");
});

test("classifyOutput — awaiting review ALWAYS runs; config-changed surfaces as 'changed'", () => {
  assert.equal(classifyOutput(state({ hasPending: true, configKey: "old" }), "new", null), "changed");
});

test("classifyOutput — a re-published layout (content version bumped) is 'changed'", () => {
  // Same row config, but the layout's published version moved 1 → 2.
  assert.equal(classifyOutput(state({ hasPending: true, contentVersion: 1 }), null, 2), "changed");
});

test("classifyOutput — awaiting review, config + layout unchanged is 'pending' (runs, not skipped)", () => {
  assert.equal(
    classifyOutput(state({ hasPending: true, configKey: "same", contentVersion: 3 }), "same", 3),
    "pending",
  );
});

test("classifyOutput — a null on either side of either comparison is 'pending', not 'changed'", () => {
  // Stored key/version null (pre-deploy / coded variant / legacy) → can't compare.
  assert.equal(classifyOutput(state({ hasPending: true, configKey: null, contentVersion: null }), "new", 2), "pending");
  // Current null (output gone from spec / no layout) → can't compare.
  assert.equal(classifyOutput(state({ hasPending: true, configKey: "old", contentVersion: 1 }), null, null), "pending");
});
