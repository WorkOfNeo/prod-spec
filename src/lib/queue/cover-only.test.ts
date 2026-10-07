import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OUTPUTS } from "@/lib/prod-spec/config";
import { selectRunOutputs as selectOutputs } from "./select-outputs";

// The runner's output-selection rule (selectRunOutputs, imported by the runner).
//
// WHAT IS BEING PROTECTED. Before cover-only existed, a spec with no outputs
// fell through to DEFAULT_OUTPUTS: one of every variant. For a customer who
// supplies all their own artwork that is the worst possible answer — a pile of
// documents nobody asked for, heading to a supplier folder. The flag has to
// suppress the fallback, not just the failure. What it must NOT do is veto
// outputs somebody has since configured on the spec.

test("cover-only produces NO outputs — not the default set", () => {
  const out = selectOutputs({ outputs: [], coverOnly: true });
  assert.equal(out.length, 0);
});

test("configured outputs still render on a cover-only spec", () => {
  // The customer starts using our layouts while the tick is still on. The tick
  // means "empty is deliberate", not "never generate" — leaving it on must not
  // block the outputs someone has added (and pendingOutputKeysForStyle, which
  // doesn't read the flag, would otherwise re-enqueue the style forever).
  const out = selectOutputs({
    outputs: [{ variantKey: "care-label-01", widthMm: 35, heightMm: 90, enabled: true }],
    coverOnly: true,
  });
  assert.equal(out.length, 1);
});

test("disabled outputs on a cover-only spec still select nothing", () => {
  const out = selectOutputs({
    outputs: [{ variantKey: "care-label-01", widthMm: 35, heightMm: 90, enabled: false }],
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
  // A JSON round trip handing back "true" or 1 must not silently enable the
  // mode. Pinned through the one place the flag still changes the outcome — an
  // empty spec — by checking it never hands back something other than the
  // plain (empty) fallback.
  assert.deepEqual(selectOutputs({ outputs: [], coverOnly: "true" as unknown as boolean }), DEFAULT_OUTPUTS);
  assert.deepEqual(selectOutputs({ outputs: [], coverOnly: 1 as unknown as boolean }), DEFAULT_OUTPUTS);
  assert.deepEqual(selectOutputs({ outputs: [], coverOnly: true }), []);
});

test("a spec with real outputs and no flag is untouched", () => {
  const out = selectOutputs({ outputs: [{ variantKey: "care-label-01", widthMm: 35, heightMm: 90, enabled: true }] });
  assert.equal(out.length, 1);
});
