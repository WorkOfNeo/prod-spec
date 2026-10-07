import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCoverRun, MAX_GEN_ATTEMPTS, type CoverRunFacts } from "./cover-run-gate";

// The cover-run failsafe: a style with no cover gets ONE generation run to
// build it. Cover-only specs have no output to trigger a run, and the
// manual-packaging rebuild only refreshes a cover that already exists — so
// without this gate such a style never got a cover at all.

const base: CoverRunFacts = {
  hasPo: true,
  prodSpec: { active: true, coverOnly: true },
  requireCoverOnly: true,
  autoGenerateEnabled: true,
  inflight: 0,
  recentFailures: 0,
  hasCover: false,
};

test("a cover-only style with no cover gets a run", () => {
  assert.equal(decideCoverRun(base), null);
});

test("once the cover exists the gate closes — no loop", () => {
  assert.equal(decideCoverRun({ ...base, hasCover: true }), "has_cover");
});

test("the sweep / ingest paths only pick up cover-only specs", () => {
  assert.equal(
    decideCoverRun({ ...base, prodSpec: { active: true, coverOnly: false } }),
    "not_cover_only",
  );
  // A coerced flag is not the flag.
  assert.equal(
    decideCoverRun({ ...base, prodSpec: { active: true, coverOnly: "true" as unknown as boolean } }),
    "not_cover_only",
  );
});

test("a manual packaging change on any spec's coverless style gets a run", () => {
  assert.equal(
    decideCoverRun({ ...base, requireCoverOnly: false, prodSpec: { active: true, coverOnly: false } }),
    null,
  );
});

test("auto-generate off holds back a run that would render outputs, not a cover-only one", () => {
  assert.equal(
    decideCoverRun({
      ...base,
      requireCoverOnly: false,
      autoGenerateEnabled: false,
      prodSpec: { active: true, coverOnly: false },
    }),
    "auto_off",
  );
  assert.equal(decideCoverRun({ ...base, requireCoverOnly: false, autoGenerateEnabled: false }), null);
});

test("the usual gates still hold", () => {
  assert.equal(decideCoverRun({ ...base, hasPo: false }), "no_po");
  assert.equal(decideCoverRun({ ...base, prodSpec: null }), "no_prodspec");
  assert.equal(decideCoverRun({ ...base, prodSpec: { active: false, coverOnly: true } }), "prodspec_inactive");
  assert.equal(decideCoverRun({ ...base, inflight: 1 }), "in_flight");
});

test("repeated failures since the spec changed float the style", () => {
  assert.equal(decideCoverRun({ ...base, recentFailures: MAX_GEN_ATTEMPTS - 1 }), null);
  assert.equal(decideCoverRun({ ...base, recentFailures: MAX_GEN_ATTEMPTS }), "floated");
});
