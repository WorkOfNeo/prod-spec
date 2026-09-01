import { test } from "node:test";
import assert from "node:assert/strict";
import { notifiesSupplier, type CoverRebuildTrigger } from "./cover-rebuild-trigger";

// The whole rule, in one place, so it cannot be re-decided at a call site.

test("a content rebuild notifies — the style's own facts moved", () => {
  assert.equal(notifiesSupplier("content"), true);
});

test("a wording rebuild does not notify — the file is re-uploaded in silence", () => {
  assert.equal(notifiesSupplier("wording"), false);
});

test("the rule is a function of the trigger alone, so it cannot latch", () => {
  // Called repeatedly, in any order, each answer depends only on its argument.
  // This is what makes "silenced once" impossible to turn into "silenced for
  // good": nothing here can read, or remember, what the last call said.
  const sequence: CoverRebuildTrigger[] = ["wording", "wording", "content", "wording", "content"];
  assert.deepEqual(sequence.map(notifiesSupplier), [false, false, true, false, true]);
});
