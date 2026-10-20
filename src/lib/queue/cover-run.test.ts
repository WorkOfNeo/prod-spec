import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCoverRun, MAX_GEN_ATTEMPTS, type CoverRunFacts } from "./cover-run-gate";

// The first-cover rule: a style gets its cover as soon as Monday's "Navision
// Task" (the PO number) has a value — for every customer. Before this, the
// cover was only built by a run that some READY output triggered, so a style
// waiting on data had no cover, and a cover-only spec never got one at all.

const base: CoverRunFacts = {
  hasPo: true,
  belowCutoff: false,
  prodSpec: { active: true, coverOnly: false },
  specHasOutputs: true,
  autoGenerateEnabled: true,
  inflight: 0,
  recentFailures: 0,
  hasCover: false,
};

test("a PO number on a style with no cover earns a run — any customer", () => {
  assert.equal(decideCoverRun(base), null);
});

test("no PO number, no cover", () => {
  assert.equal(decideCoverRun({ ...base, hasPo: false }), "no_po");
});

test("once the cover exists the gate closes — no loop", () => {
  assert.equal(decideCoverRun({ ...base, hasCover: true }), "has_cover");
});

test("a cover-only spec qualifies with no outputs at all", () => {
  assert.equal(
    decideCoverRun({ ...base, prodSpec: { active: true, coverOnly: true }, specHasOutputs: false }),
    null,
  );
});

test("a spec with no outputs and no cover-only tick is a misconfig, not a cover run", () => {
  // It would fail NO_OUTPUTS; that failure belongs to a real run, not a sweep.
  assert.equal(decideCoverRun({ ...base, specHasOutputs: false }), "no_outputs");
  // A coerced flag is not the flag.
  assert.equal(
    decideCoverRun({
      ...base,
      specHasOutputs: false,
      prodSpec: { active: true, coverOnly: "true" as unknown as boolean },
    }),
    "no_outputs",
  );
});

test("auto-generate off holds back a run that would render outputs, not a cover-only one", () => {
  assert.equal(decideCoverRun({ ...base, autoGenerateEnabled: false }), "auto_off");
  assert.equal(
    decideCoverRun({
      ...base,
      autoGenerateEnabled: false,
      prodSpec: { active: true, coverOnly: true },
      specHasOutputs: false,
    }),
    null,
  );
});

test("the historical backlog below the generation PO cutoff stays parked", () => {
  assert.equal(decideCoverRun({ ...base, belowCutoff: true }), "below_cutoff");
});

test("the usual gates still hold", () => {
  assert.equal(decideCoverRun({ ...base, prodSpec: null }), "no_prodspec");
  assert.equal(decideCoverRun({ ...base, prodSpec: { active: false, coverOnly: false } }), "prodspec_inactive");
  assert.equal(decideCoverRun({ ...base, inflight: 1 }), "in_flight");
});

test("repeated failures since the spec changed float the style", () => {
  assert.equal(decideCoverRun({ ...base, recentFailures: MAX_GEN_ATTEMPTS - 1 }), null);
  assert.equal(decideCoverRun({ ...base, recentFailures: MAX_GEN_ATTEMPTS }), "floated");
});
