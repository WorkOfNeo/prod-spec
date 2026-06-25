import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  baseVariantKey,
  currentOutputBaseKeys,
  isOrphanedOutputKey,
} from "./orphan";

describe("orphaned-ticket detection", () => {
  const current = currentOutputBaseKeys([
    { variantKey: "layout:cmqt78um2" },
    { variantKey: "layout:cmqt7pz35" },
  ]);

  it("flags a removed coded print-spec key as orphaned", () => {
    assert.equal(isOrphanedOutputKey("kaufland-private-label-carton-marking", current), true);
  });

  it("flags a removed layout key (with #suffix) as orphaned by its base", () => {
    assert.equal(isOrphanedOutputKey("layout:cmq8k5klc#L-ColourA", current), true);
  });

  it("keeps a current output (and its per-document suffix) NOT orphaned", () => {
    assert.equal(isOrphanedOutputKey("layout:cmqt78um2", current), false);
    assert.equal(isOrphanedOutputKey("layout:cmqt78um2#XL-ColourB", current), false);
  });

  it("never treats framing keys as orphaned", () => {
    assert.equal(isOrphanedOutputKey("__cover__", current), false);
    assert.equal(isOrphanedOutputKey("__general_info__", current), false);
  });

  it("never treats the legacy empty key as orphaned (full regen)", () => {
    assert.equal(isOrphanedOutputKey("", current), false);
  });

  it("baseVariantKey strips the document suffix", () => {
    assert.equal(baseVariantKey("layout:abc#XL-Black"), "layout:abc");
    assert.equal(baseVariantKey("kaufland-carton"), "kaufland-carton");
  });

  it("with an empty spec, every real output key is orphaned", () => {
    const none = currentOutputBaseKeys([]);
    assert.equal(isOrphanedOutputKey("layout:anything", none), true);
    assert.equal(isOrphanedOutputKey("__cover__", none), false);
  });
});
