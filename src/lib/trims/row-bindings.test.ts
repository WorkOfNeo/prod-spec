import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bindLabelToRow,
  effectiveRowsForLabel,
  labelsBoundToRow,
  otherRowsForLabel,
  unbindLabelFromRow,
  unbindingWouldSuppress,
  type BindableLabel,
} from "./row-bindings";

const lbl = (normalized: string, suggested: string[], styles = 1): BindableLabel => ({
  label: normalized,
  normalized,
  styles,
  suggested,
});

test("effectiveRowsForLabel — a stored decision beats the rule, including the empty one", () => {
  const l = lbl("hangtag", ["HANGTAG"]);
  assert.deepEqual(effectiveRowsForLabel({}, l), ["HANGTAG"]);
  assert.deepEqual(effectiveRowsForLabel({ hangtag: ["CARE_LABEL"] }, l), ["CARE_LABEL"]);
  // "not packaging" is a decision, not an absent one.
  assert.deepEqual(effectiveRowsForLabel({ hangtag: [] }, l), []);
});

test("bindLabelToRow — materialises the rule suggestion instead of replacing it", () => {
  const l = lbl("hanger & hangtag", ["HANGER"]);
  const next = bindLabelToRow({}, l, "HANGTAG");
  assert.deepEqual(next["hanger & hangtag"], ["HANGER", "HANGTAG"]);
});

test("bindLabelToRow — is idempotent, but still stores the decision", () => {
  const l = lbl("hangtag", ["HANGTAG"]);
  const next = bindLabelToRow({}, l, "HANGTAG");
  // Same rows — and now a DECISION, so a later rule edit cannot move it.
  assert.deepEqual(next.hangtag, ["HANGTAG"]);
  assert.deepEqual(bindLabelToRow(next, l, "HANGTAG").hangtag, ["HANGTAG"]);
});

test("unbindLabelFromRow — keeps the other rows a compound value names", () => {
  const l = lbl("hanger & hangtag", ["HANGER", "HANGTAG"]);
  assert.deepEqual(unbindLabelFromRow({}, l, "HANGER")["hanger & hangtag"], ["HANGTAG"]);
});

test("unbindLabelFromRow — the last row leaves 'not packaging', never an absent key", () => {
  const l = lbl("hangtag", ["HANGTAG"]);
  const next = unbindLabelFromRow({}, l, "HANGTAG");
  // Deleting the key would hand it straight back to the rule that put it there.
  assert.equal(Object.prototype.hasOwnProperty.call(next, "hangtag"), true);
  assert.deepEqual(next.hangtag, []);
  assert.equal(unbindingWouldSuppress({}, l, "HANGTAG"), true);
  assert.equal(unbindingWouldSuppress({}, lbl("x", ["A", "B"]), "A"), false);
});

test("labelsBoundToRow — includes rule-followers, most-used first", () => {
  const labels = [
    lbl("wash care label", ["CARE_LABEL"], 40),
    lbl("oeko-tex care label", ["CARE_LABEL"], 900),
    lbl("hangtag", ["HANGTAG"], 500),
    // Decided away from the rule — must NOT appear under CARE_LABEL.
    lbl("care label ish", ["CARE_LABEL"], 700),
  ];
  const overrides = { "care label ish": ["HANGTAG"] };
  assert.deepEqual(
    labelsBoundToRow(overrides, labels, "CARE_LABEL").map((l) => l.normalized),
    ["oeko-tex care label", "wash care label"],
  );
  // A row with no id yet (a freshly added, unsaved row) binds nothing.
  assert.deepEqual(labelsBoundToRow(overrides, labels, ""), []);
});

test("otherRowsForLabel — names where else a value is already printing", () => {
  const l = lbl("hanger & hangtag", ["HANGER", "HANGTAG"]);
  assert.deepEqual(otherRowsForLabel({}, l, "HANGER"), ["HANGTAG"]);
});
