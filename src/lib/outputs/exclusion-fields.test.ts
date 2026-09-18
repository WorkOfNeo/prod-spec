import { test } from "node:test";
import assert from "node:assert/strict";
import { EXCLUSION_FIELDS, COMMON_RULE_FIELDS, RULE_FIELD_GROUPS, exclusionFieldLabel } from "./exclusion";
import { STYLE_FIELD_LABELS } from "@/lib/styles/resolved-fields";

// The rule editors' field menu is DERIVED from STYLE_FIELD_LABELS rather than
// curated, so mapping a new Monday column exposes it as a rule field with no
// code change. These lock that property — the whole point of the change.

test("every mapped style field is offered as a rule field", () => {
  const offered = new Set(EXCLUSION_FIELDS.map((f) => f.field));
  for (const field of Object.keys(STYLE_FIELD_LABELS)) {
    assert.ok(offered.has(field), `${field} is mapped but not offered as a rule field`);
  }
  assert.equal(offered.size, Object.keys(STYLE_FIELD_LABELS).length);
});

test("no duplicates", () => {
  const seen = new Set<string>();
  for (const f of EXCLUSION_FIELDS) {
    assert.ok(!seen.has(f.field), `duplicate field ${f.field}`);
    seen.add(f.field);
  }
});

test("labels come from the shared map, so they match the Details tab", () => {
  for (const f of EXCLUSION_FIELDS) {
    assert.equal(f.label, (STYLE_FIELD_LABELS as Record<string, string>)[f.field]);
    assert.equal(exclusionFieldLabel(f.field), f.label);
  }
});

test("the common fields come first, in their declared order", () => {
  const head = EXCLUSION_FIELDS.slice(0, COMMON_RULE_FIELDS.length);
  assert.deepEqual(head.map((f) => f.field), [...COMMON_RULE_FIELDS]);
  assert.ok(head.every((f) => f.group === RULE_FIELD_GROUPS.common));
  // productGroup stays the first thing an operator sees.
  assert.equal(EXCLUSION_FIELDS[0].field, "productGroup");
});

test("the rest are grouped under All fields and sorted by label", () => {
  const rest = EXCLUSION_FIELDS.slice(COMMON_RULE_FIELDS.length);
  assert.ok(rest.every((f) => f.group === RULE_FIELD_GROUPS.all));
  assert.deepEqual(
    rest.map((f) => f.label),
    [...rest.map((f) => f.label)].sort((a, b) => a.localeCompare(b)),
  );
  // No common field leaks into the second group.
  assert.equal(rest.some((f) => COMMON_RULE_FIELDS.includes(f.field)), false);
});

test("the fields this change was asked for are present", () => {
  const offered = new Set(EXCLUSION_FIELDS.map((f) => f.field));
  // Size Ratio is the field Niels asked for; styleComments is the one added
  // earlier today — both should be there without having been listed by hand.
  assert.ok(offered.has("sizeRatio"));
  assert.ok(offered.has("styleComments"));
  assert.equal(exclusionFieldLabel("sizeRatio"), "Size ratio (assortment)");
});
