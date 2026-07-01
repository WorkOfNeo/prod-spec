import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveOutputState,
  rollupOutputs,
  selectCurrentAssets,
  approvedBaseVariantKeys,
  type CurrentOutput,
  type OutputState,
} from "./current-outputs";

// Asset shape approvedBaseVariantKeys needs (adds review fields to `asset`).
function ra(
  jobId: string,
  variantKey: string | null,
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED",
  placeholderCount = 0,
  docType = "CARTON",
) {
  return { jobId, variantKey, docType, reviewStatus, placeholderCount };
}
const sorted = (s: Set<string>) => [...s].sort();

// Minimal asset shape selectCurrentAssets needs (newest-job-first input).
function asset(jobId: string, variantKey: string | null, docType = "CARTON") {
  return { jobId, variantKey, docType };
}
const keys = (as: Array<{ variantKey: string | null }>) => as.map((a) => a.variantKey);

test("selectCurrentAssets — supersedes a base by its newest job (changed suffix scheme drops)", () => {
  // PTQ20029 shape: an old run rejected docs under "#<size>-<colour>"; a newer
  // run re-generated the SAME declared base under "#<size><cm>-<colour>". The
  // old-suffix rejects must drop — only the newest job's docs are current.
  const declared = new Set(["layout:A"]);
  const current = selectCurrentAssets(
    [
      asset("job2", "layout:A#122128cm-Pink"), // newest job
      asset("job2", "layout:A#86cm-Pink"),
      asset("job1", "layout:A#122128-Blue"), // older job, old scheme
      asset("job1", "layout:A#86-Navy"),
      asset("job1", "layout:A#86-Pink"),
    ],
    declared,
  );
  assert.deepEqual(keys(current).sort(), ["layout:A#122128cm-Pink", "layout:A#86cm-Pink"]);
});

test("selectCurrentAssets — drops orphaned bases, keeps declared + framing", () => {
  const declared = new Set(["layout:A"]);
  const current = selectCurrentAssets(
    [
      asset("job2", "layout:A#1"),
      asset("job2", "__cover__"), // framing — never orphaned
      asset("job1", "layout:GONE#1"), // removed-from-spec → orphan
    ],
    declared,
  );
  assert.deepEqual(keys(current).sort(), ["__cover__", "layout:A#1"]);
});

test("selectCurrentAssets — skips retired __general_info__, keeps legacy null keys", () => {
  const current = selectCurrentAssets(
    [
      asset("job1", "__general_info__"),
      asset("job1", null, "WASHCARE"), // legacy null variantKey → kept, not guessed-orphan
      asset("job1", "layout:A"),
    ],
    new Set(["layout:A"]),
  );
  assert.equal(current.some((a) => a.variantKey === "__general_info__"), false);
  assert.equal(current.some((a) => a.variantKey === null), true);
  assert.equal(current.some((a) => a.variantKey === "layout:A"), true);
});

test("selectCurrentAssets — drops EXCLUDED bases so a stale reject doesn't surface", () => {
  // LS90058 shape: the Care Label is excluded (socks product), but old rejected
  // docs linger because the re-run skipped it. The excluded base's assets must
  // drop so the declared-output pass re-emits it as EXCLUDED.
  const declared = new Set(["layout:CARE", "layout:OK"]);
  const excluded = new Set(["layout:CARE"]);
  const current = selectCurrentAssets(
    [
      asset("job2", "layout:OK"),
      asset("job1", "layout:CARE#86-Pink"), // old rejected care-label docs
      asset("job1", "layout:CARE#98-Pink"),
    ],
    declared,
    excluded,
  );
  assert.deepEqual(keys(current).sort(), ["layout:OK"]);
});

test("selectCurrentAssets — newest job is per-base (a scoped rerun of one base leaves others)", () => {
  const declared = new Set(["layout:A", "layout:B"]);
  const current = selectCurrentAssets(
    [
      asset("job3", "layout:A"), // newest job touched only A
      asset("job2", "layout:B#x"), // B last generated in job2
      asset("job2", "layout:B#y"),
    ],
    declared,
  );
  assert.deepEqual(keys(current).sort(), ["layout:A", "layout:B#x", "layout:B#y"]);
});

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

// ---- approvedBaseVariantKeys (durable-approval render-set) ----

test("approvedBaseVariantKeys — a clean approved single-doc base is durable", () => {
  const got = approvedBaseVariantKeys(
    [ra("job1", "layout:A", "APPROVED"), ra("job1", "layout:B", "PENDING_REVIEW")],
    new Set(["layout:A", "layout:B"]),
  );
  assert.deepEqual(sorted(got), ["layout:A"]);
});

test("approvedBaseVariantKeys — an approved-but-placeholdered doc is NOT durable", () => {
  const got = approvedBaseVariantKeys(
    [ra("job1", "layout:A", "APPROVED", 2)],
    new Set(["layout:A"]),
  );
  assert.deepEqual(sorted(got), []);
});

test("approvedBaseVariantKeys — rejected / pending bases are not durable", () => {
  const got = approvedBaseVariantKeys(
    [ra("job1", "layout:A", "REJECTED"), ra("job1", "layout:B", "PENDING_REVIEW")],
    new Set(["layout:A", "layout:B"]),
  );
  assert.deepEqual(sorted(got), []);
});

test("approvedBaseVariantKeys — multi-doc base durable only when ALL docs approved+clean", () => {
  // One suffix rejected → whole base must regenerate.
  const partial = approvedBaseVariantKeys(
    [ra("job1", "layout:A#Red", "APPROVED"), ra("job1", "layout:A#Blue", "REJECTED")],
    new Set(["layout:A"]),
  );
  assert.deepEqual(sorted(partial), []);
  // All suffixes approved → durable.
  const all = approvedBaseVariantKeys(
    [ra("job1", "layout:A#Red", "APPROVED"), ra("job1", "layout:A#Blue", "APPROVED")],
    new Set(["layout:A"]),
  );
  assert.deepEqual(sorted(all), ["layout:A"]);
});

test("approvedBaseVariantKeys — only the NEWEST job's assets decide (supersede)", () => {
  // Older job approved the base; a newer job re-generated it as PENDING —
  // the current asset is pending, so the base is NOT durable anymore.
  const got = approvedBaseVariantKeys(
    [ra("job2", "layout:A", "PENDING_REVIEW"), ra("job1", "layout:A", "APPROVED")],
    new Set(["layout:A"]),
  );
  assert.deepEqual(sorted(got), []);
});

test("approvedBaseVariantKeys — orphaned + excluded bases never durable", () => {
  const orphan = approvedBaseVariantKeys(
    [ra("job1", "layout:GONE", "APPROVED")],
    new Set(["layout:A"]),
  );
  assert.deepEqual(sorted(orphan), []);
  const excluded = approvedBaseVariantKeys(
    [ra("job1", "layout:A", "APPROVED")],
    new Set(["layout:A"]),
    new Set(["layout:A"]),
  );
  assert.deepEqual(sorted(excluded), []);
});
