import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchExclusionRules,
  parseExclusionRules,
  exclusionReasonText,
  type ExclusionRule,
} from "./exclusion";

// A resolver standing in for the server-built one: maps field → the style's
// raw value (e.g. "productGroup" → "3-Pack Socks").
const resolver = (values: Record<string, string>) => (field: string) => values[field] ?? "";

test("matchExclusionRules — contains is case-insensitive substring", () => {
  const rules: ExclusionRule[] = [{ field: "productGroup", op: "contains", keywords: ["sock"] }];
  const hit = matchExclusionRules(rules, resolver({ productGroup: "3-Pack Socks" }));
  assert.ok(hit);
  assert.equal(hit?.field, "productGroup");
  assert.equal(hit?.keyword, "sock");
});

test("matchExclusionRules — equals needs the whole field", () => {
  const rules: ExclusionRule[] = [{ field: "productGroup", op: "equals", keywords: ["Shoes"] }];
  assert.equal(matchExclusionRules(rules, resolver({ productGroup: "Shoes" }))?.keyword, "Shoes");
  // "Swim Shoes" is not exactly "Shoes" → no match under equals.
  assert.equal(matchExclusionRules(rules, resolver({ productGroup: "Swim Shoes" })), null);
});

test("matchExclusionRules — any keyword in the list fires", () => {
  const rules: ExclusionRule[] = [
    { field: "productGroup", op: "contains", keywords: ["shoes", "boot", "sandal", "sock"] },
  ];
  assert.ok(matchExclusionRules(rules, resolver({ productGroup: "Chelsea Boot" })));
  assert.ok(matchExclusionRules(rules, resolver({ productGroup: "Leather Sandals" })));
  assert.equal(matchExclusionRules(rules, resolver({ productGroup: "Cotton T-Shirt" })), null);
});

test("matchExclusionRules — empty field value never matches", () => {
  const rules: ExclusionRule[] = [{ field: "productGroup", op: "contains", keywords: ["sock"] }];
  assert.equal(matchExclusionRules(rules, resolver({})), null);
});

test("matchExclusionRules — no rules / no keywords → null", () => {
  assert.equal(matchExclusionRules(undefined, resolver({ productGroup: "Socks" })), null);
  assert.equal(matchExclusionRules([], resolver({ productGroup: "Socks" })), null);
  assert.equal(
    matchExclusionRules(
      [{ field: "productGroup", op: "contains", keywords: [] }],
      resolver({ productGroup: "Socks" }),
    ),
    null,
  );
});

test("parseExclusionRules — drops malformed entries and blank keywords", () => {
  const parsed = parseExclusionRules([
    { field: "productGroup", op: "contains", keywords: ["shoes", "", "  sock  "] },
    { field: "", op: "contains", keywords: ["x"] }, // no field → dropped
    { field: "colourName", op: "equals", keywords: [] }, // no keywords → dropped
    { field: "targetGroup", op: "weird", keywords: ["kids"] }, // bad op → defaults to contains
    "garbage",
  ]);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { field: "productGroup", op: "contains", keywords: ["shoes", "sock"] });
  assert.deepEqual(parsed[1], { field: "targetGroup", op: "contains", keywords: ["kids"] });
});

test("exclusionReasonText — names field, keyword and doc type", () => {
  const reason = exclusionReasonText(
    { field: "productGroup", op: "contains", keyword: "shoes" },
    "Wash care",
  );
  assert.equal(reason, "Not generated — Product group contains “shoes” (Wash care rule)");
});
