import { test } from "node:test";
import assert from "node:assert/strict";
import { baseKey, rollupStyleSlots, isFullyDelivered } from "./style-dashboard";

// A slot document as rollupStyleSlots consumes it.
function doc(
  base: string,
  state: Parameters<typeof rollupStyleSlots>[0][number]["state"],
  opts: { generated?: boolean; uploaded?: boolean; emailed?: boolean } = {},
) {
  return {
    base,
    state,
    generated: opts.generated ?? true,
    uploaded: opts.uploaded ?? false,
    emailed: opts.emailed ?? false,
  };
}

test("baseKey — strips the #suffix of a multi-document slot", () => {
  assert.equal(baseKey("layout:5#L-ColourA", "CARTON"), "layout:5");
  assert.equal(baseKey("WASHCARE-standard", "WASHCARE"), "WASHCARE-standard");
});

test("baseKey — legacy null variantKey collapses to doc:<docType> (matches the queue side)", () => {
  assert.equal(baseKey(null, "WASHCARE"), "doc:WASHCARE");
});

test("rollupStyleSlots — collapses a multi-document slot to one, most-actionable state wins", () => {
  // Two documents of the same carton slot: one approved, one rejected. The slot
  // is one row and reads REJECTED (more actionable than APPROVED).
  const { rollup, states } = rollupStyleSlots([
    doc("layout:1", "APPROVED", { uploaded: true }),
    doc("layout:1", "REJECTED", { uploaded: true }),
  ]);
  assert.equal(rollup.generatedSlots, 1);
  assert.equal(rollup.rejected, 1);
  assert.equal(rollup.approved, 0);
  assert.equal(rollup.uploadedSlots, 1); // any document uploaded ⇒ slot uploaded
  assert.deepEqual(states, ["REJECTED"]);
});

test("rollupStyleSlots — uploaded/emailed facet sets reflect the mix across slots", () => {
  const { rollup, states, uploadStates, emailStates } = rollupStyleSlots([
    doc("a", "TO_REVIEW"), // generated, not uploaded, not sent
    doc("b", "APPROVED", { uploaded: true, emailed: true }),
  ]);
  assert.equal(rollup.generatedSlots, 2);
  assert.equal(rollup.toReview, 1);
  assert.equal(rollup.approved, 1);
  assert.equal(rollup.uploadedSlots, 1);
  assert.equal(rollup.sentSlots, 1);
  assert.deepEqual(states, ["TO_REVIEW", "APPROVED"]);
  assert.deepEqual(uploadStates, ["uploaded", "not-uploaded"]);
  assert.deepEqual(emailStates, ["sent", "not-sent"]);
});

test("rollupStyleSlots — a generating slot counts and reads as not-uploaded/not-sent", () => {
  const { rollup, uploadStates, emailStates } = rollupStyleSlots([doc("x", "GENERATING")]);
  assert.equal(rollup.generating, 1);
  assert.equal(rollup.uploadedSlots, 0);
  assert.equal(rollup.sentSlots, 0);
  assert.deepEqual(uploadStates, ["not-uploaded"]);
  assert.deepEqual(emailStates, ["not-sent"]);
});

test("rollupStyleSlots — all uploaded + sent ⇒ no 'not-uploaded'/'not-sent' facet values", () => {
  const { uploadStates, emailStates } = rollupStyleSlots([
    doc("a", "APPROVED", { uploaded: true, emailed: true }),
    doc("b", "APPROVED", { uploaded: true, emailed: true }),
  ]);
  assert.deepEqual(uploadStates, ["uploaded"]);
  assert.deepEqual(emailStates, ["sent"]);
});

test("isFullyDelivered — every slot generated, approved, uploaded and sent", () => {
  const { rollup } = rollupStyleSlots([
    doc("a", "APPROVED", { uploaded: true, emailed: true }),
    doc("b", "APPROVED", { uploaded: true, emailed: true }),
  ]);
  assert.equal(isFullyDelivered(rollup), true);
});

test("isFullyDelivered — a never-generated declared output keeps it un-delivered", () => {
  // The KH30110 case: two outputs shipped, two never generated (the runner
  // readiness-gated them). Not done, so not green.
  const { rollup } = rollupStyleSlots([doc("a", "APPROVED", { uploaded: true, emailed: true })], 2);
  assert.equal(rollup.notGenerated, 2);
  assert.equal(isFullyDelivered(rollup), false);
});

test("isFullyDelivered — uploaded but not emailed is not delivered", () => {
  const { rollup } = rollupStyleSlots([doc("a", "APPROVED", { uploaded: true })]);
  assert.equal(isFullyDelivered(rollup), false);
});

test("isFullyDelivered — an undecided (to review) output keeps it un-delivered", () => {
  const { rollup } = rollupStyleSlots([
    doc("a", "APPROVED", { uploaded: true, emailed: true }),
    doc("b", "TO_REVIEW", { uploaded: true, emailed: true }),
  ]);
  assert.equal(isFullyDelivered(rollup), false);
});

test("isFullyDelivered — a style with nothing generated is not delivered", () => {
  const { rollup } = rollupStyleSlots([], 2);
  assert.equal(isFullyDelivered(rollup), false);
});
