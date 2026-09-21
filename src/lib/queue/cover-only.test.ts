import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProdSpecOutputs, DEFAULT_OUTPUTS } from "@/lib/prod-spec/config";

// The runner's output-selection rule, extracted exactly as it is written there.
// Kept in step by hand rather than exported, because the runner's copy is three
// lines inside a 1,000-line function and lifting it out would be a bigger change
// than the feature — but the branch that matters is pinned here.
//
// WHAT IS BEING PROTECTED. Before cover-only existed, a spec with no outputs
// fell through to DEFAULT_OUTPUTS: one of every variant. For a customer who
// supplies all their own artwork that is the worst possible answer — a pile of
// documents nobody asked for, heading to a supplier folder. The flag has to
// suppress the fallback, not just the failure.
function selectOutputs(prodSpec: { outputs: unknown; coverOnly?: boolean } | null) {
  const coverOnly = prodSpec?.coverOnly === true;
  if (coverOnly) return [];
  if (prodSpec) {
    const parsed = parseProdSpecOutputs(prodSpec.outputs);
    const enabled = parsed.filter((o) => o.enabled !== false);
    if (enabled.length > 0) return enabled;
  }
  return DEFAULT_OUTPUTS;
}

test("cover-only produces NO outputs — not the default set", () => {
  const out = selectOutputs({ outputs: [], coverOnly: true });
  assert.equal(out.length, 0);
});

test("cover-only wins even when the spec still carries outputs", () => {
  // Somebody ticks cover-only on a spec that already had outputs configured.
  // The tick is the statement of intent; the stale list must not override it.
  const out = selectOutputs({
    outputs: [{ variantKey: "care-label-01", widthMm: 35, heightMm: 90, enabled: true }],
    coverOnly: true,
  });
  assert.equal(out.length, 0);
});

test("DEFAULT_OUTPUTS is empty — the 'fallback' produces nothing", () => {
  // Worth pinning, because the runner's comment beside it still claims it is
  // "one of each variant". It is not, and has not been: the constant is []. An
  // empty spec therefore reaches the generate loop with nothing to do and
  // raises NO_OUTPUTS downstream — which is the failure a cover-only spec has
  // to stop being treated as.
  assert.equal(DEFAULT_OUTPUTS.length, 0);
});

test("without the flag, an empty spec still selects nothing — unchanged behaviour", () => {
  // The old path, untouched. Empty keeps meaning "somebody forgot" for every
  // spec that has not opted in, and still ends in NO_OUTPUTS.
  assert.equal(selectOutputs({ outputs: [], coverOnly: false }).length, 0);
});

test("an absent flag reads as off, never as cover-only", () => {
  // Same empty result, but for the opposite reason — and that is the whole
  // problem the flag solves: the OUTCOME is identical, so only an explicit
  // statement of intent can tell "deliberate" apart from "forgotten".
  assert.equal(selectOutputs({ outputs: [] }).length, 0);
});

test("only a literal true counts", () => {
  // A JSON round trip handing back "true" or 1 must not silently enable a mode
  // that suppresses every document a customer was expecting.
  // With a spec that HAS outputs, so a coerced flag would visibly differ from
  // a real one: a literal true returns [], anything else returns the outputs.
  const withOutputs = { outputs: [{ variantKey: "care-label-01", widthMm: 35, heightMm: 90, enabled: true }] };
  assert.equal(selectOutputs({ ...withOutputs, coverOnly: "true" as unknown as boolean }).length, 1);
  assert.equal(selectOutputs({ ...withOutputs, coverOnly: 1 as unknown as boolean }).length, 1);
  assert.equal(selectOutputs({ ...withOutputs, coverOnly: true }).length, 0);
});

test("a spec with real outputs and no flag is untouched", () => {
  const out = selectOutputs({ outputs: [{ variantKey: "care-label-01", widthMm: 35, heightMm: 90, enabled: true }] });
  assert.equal(out.length, 1);
});
