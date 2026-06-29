import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveOutputState,
  rollupOutputs,
  type CurrentOutput,
  type OutputState,
} from "./current-outputs";

test("deriveOutputState — generation in flight wins over everything", () => {
  assert.equal(
    deriveOutputState({ ready: true, generating: true, latest: null }),
    "GENERATING",
  );
  // Re-running an approved output shows GENERATING until the new asset lands.
  assert.equal(
    deriveOutputState({
      ready: true,
      generating: true,
      latest: { reviewStatus: "APPROVED", placeholderCount: 0 },
    }),
    "GENERATING",
  );
});

test("deriveOutputState — from the latest asset", () => {
  assert.equal(
    deriveOutputState({ ready: true, generating: false, latest: { reviewStatus: "APPROVED", placeholderCount: 0 } }),
    "APPROVED",
  );
  assert.equal(
    deriveOutputState({ ready: true, generating: false, latest: { reviewStatus: "REJECTED", placeholderCount: 0 } }),
    "REJECTED",
  );
  assert.equal(
    deriveOutputState({ ready: true, generating: false, latest: { reviewStatus: "PENDING_REVIEW", placeholderCount: 0 } }),
    "TO_REVIEW",
  );
  assert.equal(
    deriveOutputState({ ready: true, generating: false, latest: { reviewStatus: "PENDING_REVIEW", placeholderCount: 3 } }),
    "BLOCKED",
  );
});

test("deriveOutputState — not generated yet", () => {
  assert.equal(deriveOutputState({ ready: true, generating: false, latest: null }), "READY_TO_GENERATE");
  assert.equal(deriveOutputState({ ready: false, generating: false, latest: null }), "AWAITING_DATA");
});

function out(state: OutputState, hasAsset: boolean): CurrentOutput {
  return {
    variantKey: `vk-${state}-${hasAsset}`,
    name: state,
    state,
    ready: true,
    missing: [],
    docType: "CARE_LABEL",
    jobId: hasAsset ? "job-1" : null,
    fileName: hasAsset ? "01.pdf" : null,
    jobAssetId: hasAsset ? "asset-1" : null,
    reviewStatus: hasAsset ? "PENDING_REVIEW" : null,
    reviewedAt: null,
    reviewedById: null,
    rejectReason: null,
    placeholderCount: 0,
    generatedAt: hasAsset ? new Date("2026-06-01T00:00:00Z") : null,
    fromLatestGeneration: hasAsset,
    exclusionReason: null,
  };
}

// An output skipped by a doc-type keyword rule: no asset, decided by exclusion.
function excluded(): CurrentOutput {
  return { ...out("EXCLUDED", false), state: "EXCLUDED", exclusionReason: "Not generated — Product group contains “shoes” (Wash care rule)" };
}

test("rollupOutputs — mixed spec is not complete", () => {
  const r = rollupOutputs([
    out("APPROVED", true),
    out("TO_REVIEW", true),
    out("AWAITING_DATA", false),
  ]);
  assert.equal(r.total, 3);
  assert.equal(r.generated, 2);
  assert.equal(r.approved, 1);
  assert.equal(r.toReview, 1);
  assert.equal(r.awaitingData, 1);
  assert.equal(r.complete, false); // one output not generated
  assert.equal(r.fullyApproved, false);
});

test("rollupOutputs — all generated → complete; all approved → fullyApproved", () => {
  const complete = rollupOutputs([out("APPROVED", true), out("REJECTED", true)]);
  assert.equal(complete.complete, true);
  assert.equal(complete.fullyApproved, false);

  const done = rollupOutputs([out("APPROVED", true), out("APPROVED", true)]);
  assert.equal(done.complete, true);
  assert.equal(done.fullyApproved, true);
});

test("rollupOutputs — empty is neither complete nor fully approved", () => {
  const r = rollupOutputs([]);
  assert.equal(r.total, 0);
  assert.equal(r.complete, false);
  assert.equal(r.fullyApproved, false);
});

test("rollupOutputs — excluded outputs count as decided", () => {
  // A sock style: wash-care excluded, the rest approved → complete + fully
  // approved (nothing pending), with the excluded one tallied.
  const r = rollupOutputs([out("APPROVED", true), excluded()]);
  assert.equal(r.total, 2);
  assert.equal(r.generated, 1);
  assert.equal(r.approved, 1);
  assert.equal(r.excluded, 1);
  assert.equal(r.complete, true);
  assert.equal(r.fullyApproved, true);
});

test("rollupOutputs — all excluded → complete + fully approved", () => {
  const r = rollupOutputs([excluded(), excluded()]);
  assert.equal(r.excluded, 2);
  assert.equal(r.complete, true);
  assert.equal(r.fullyApproved, true);
});

test("rollupOutputs — excluded + still-awaiting is not complete", () => {
  const r = rollupOutputs([excluded(), out("AWAITING_DATA", false)]);
  assert.equal(r.excluded, 1);
  assert.equal(r.complete, false);
  assert.equal(r.fullyApproved, false);
});
