import { test } from "node:test";
import assert from "node:assert/strict";
import { enabledBaseKeys, gainedOutputKeys } from "./outputs-version";

const o = (variantKey: string, enabled?: boolean) => ({ variantKey, enabled });

test("enabledBaseKeys — absent `enabled` counts as on (schema default)", () => {
  assert.deepEqual([...enabledBaseKeys([o("a"), o("b", true)])], ["a", "b"]);
});

test("enabledBaseKeys — disabled outputs are dropped", () => {
  assert.deepEqual([...enabledBaseKeys([o("a"), o("b", false)])], ["a"]);
});

test("enabledBaseKeys — multi-document keys collapse to their base", () => {
  assert.deepEqual([...enabledBaseKeys([o("layout:x#L-A"), o("layout:x#L-B")])], ["layout:x"]);
});

test("gainedOutputKeys — an added output is a gain", () => {
  assert.deepEqual(gainedOutputKeys([o("a")], [o("a"), o("b")]), ["b"]);
});

test("gainedOutputKeys — re-enabling a disabled output is a gain", () => {
  assert.deepEqual(gainedOutputKeys([o("a"), o("b", false)], [o("a"), o("b", true)]), ["b"]);
});

test("gainedOutputKeys — removal is NOT a gain (nothing to generate)", () => {
  assert.deepEqual(gainedOutputKeys([o("a"), o("b")], [o("a")]), []);
});

test("gainedOutputKeys — disabling is NOT a gain", () => {
  assert.deepEqual(gainedOutputKeys([o("a"), o("b")], [o("a"), o("b", false)]), []);
});

test("gainedOutputKeys — editing an existing output in place is NOT a gain", () => {
  // Geometry / pins / barcode prefs live outside the key. Those are the
  // "changed" bucket, which must never auto-regenerate approved work.
  const before = [{ variantKey: "a", widthMm: 30 }];
  const after = [{ variantKey: "a", widthMm: 40 }];
  assert.deepEqual(gainedOutputKeys(before, after), []);
});

test("gainedOutputKeys — no previous outputs means every declared output is new", () => {
  assert.deepEqual(gainedOutputKeys([], [o("a"), o("b")]), ["a", "b"]);
});

test("gainedOutputKeys — a swap reports only the incoming key", () => {
  // Replacing a coded carton spec with an Output Builder layout: the removal is
  // handled by the orphan-ticket cleanup, the addition is what needs generating.
  assert.deepEqual(gainedOutputKeys([o("carton-01")], [o("layout:abc")]), ["layout:abc"]);
});
