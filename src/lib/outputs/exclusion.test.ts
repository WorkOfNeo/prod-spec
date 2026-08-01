import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchOutputRules,
  matchOutputRulesFor,
  parseOutputRules,
  exclusionReasonText,
  ruleSentence,
  type OutputRule,
} from "./exclusion";

// A resolver standing in for the server-built one: maps field → the style's
// raw value (e.g. "productGroup" → "3-Pack Socks").
const resolver = (values: Record<string, string>) => (field: string) => values[field] ?? "";

test("matchOutputRules — contains is case-insensitive substring", () => {
  const rules: OutputRule[] = [{ field: "productGroup", op: "contains", keywords: ["sock"] }];
  const hit = matchOutputRules(rules, resolver({ productGroup: "3-Pack Socks" }));
  assert.ok(hit);
  assert.equal(hit?.field, "productGroup");
  assert.deepEqual(hit?.keywords, ["sock"]);
  assert.equal(hit?.mode, "exclude");
});

test("matchOutputRules — equals needs the whole field", () => {
  const rules: OutputRule[] = [{ field: "productGroup", op: "equals", keywords: ["Shoes"] }];
  assert.deepEqual(matchOutputRules(rules, resolver({ productGroup: "Shoes" }))?.keywords, ["Shoes"]);
  // "Swim Shoes" is not exactly "Shoes" → no match under equals.
  assert.equal(matchOutputRules(rules, resolver({ productGroup: "Swim Shoes" })), null);
});

test("matchOutputRules — any keyword in the list fires", () => {
  const rules: OutputRule[] = [
    { field: "productGroup", op: "contains", keywords: ["shoes", "boot", "sandal", "sock"] },
  ];
  assert.ok(matchOutputRules(rules, resolver({ productGroup: "Chelsea Boot" })));
  assert.ok(matchOutputRules(rules, resolver({ productGroup: "Leather Sandals" })));
  assert.equal(matchOutputRules(rules, resolver({ productGroup: "Cotton T-Shirt" })), null);
});

test("matchOutputRules — empty field value never matches", () => {
  const rules: OutputRule[] = [{ field: "productGroup", op: "contains", keywords: ["sock"] }];
  assert.equal(matchOutputRules(rules, resolver({})), null);
});

test("matchOutputRules — no rules / no keywords → null", () => {
  assert.equal(matchOutputRules(undefined, resolver({ productGroup: "Socks" })), null);
  assert.equal(matchOutputRules([], resolver({ productGroup: "Socks" })), null);
  assert.equal(
    matchOutputRules(
      [{ field: "productGroup", op: "contains", keywords: [] }],
      resolver({ productGroup: "Socks" }),
    ),
    null,
  );
});

// ---- include mode: "generate ONLY when …" ----------------------------------

test("matchOutputRules — include generates for a matching style, skips the rest", () => {
  // The shoe-only barcode sticker.
  const rules: OutputRule[] = [
    { field: "productGroup", op: "contains", keywords: ["shoes"], mode: "include" },
  ];
  assert.equal(matchOutputRules(rules, resolver({ productGroup: "Kids Shoes" })), null);

  const miss = matchOutputRules(rules, resolver({ productGroup: "Socks" }));
  assert.ok(miss);
  assert.equal(miss?.mode, "include");
  assert.deepEqual(miss?.keywords, ["shoes"]);
});

test("matchOutputRules — include with an empty field skips (nothing to match)", () => {
  const rules: OutputRule[] = [
    { field: "productGroup", op: "contains", keywords: ["shoes"], mode: "include" },
  ];
  assert.ok(matchOutputRules(rules, resolver({})));
});

test("matchOutputRules — several include rules are alternatives", () => {
  const rules: OutputRule[] = [
    { field: "productGroup", op: "contains", keywords: ["shoes"], mode: "include" },
    { field: "targetGroup", op: "equals", keywords: ["Kids"], mode: "include" },
  ];
  assert.equal(matchOutputRules(rules, resolver({ productGroup: "Shoes" })), null);
  assert.equal(matchOutputRules(rules, resolver({ targetGroup: "Kids" })), null);
  assert.ok(matchOutputRules(rules, resolver({ productGroup: "Socks", targetGroup: "Men" })));
});

test("matchOutputRules — an exclude match vetoes a satisfied include", () => {
  const rules: OutputRule[] = [
    { field: "productGroup", op: "contains", keywords: ["shoes"], mode: "include" },
    { field: "colourName", op: "contains", keywords: ["sample"], mode: "exclude" },
  ];
  assert.equal(matchOutputRules(rules, resolver({ productGroup: "Shoes" })), null);
  const vetoed = matchOutputRules(
    rules,
    resolver({ productGroup: "Shoes", colourName: "Sample Red" }),
  );
  assert.equal(vetoed?.mode, "exclude");
  assert.deepEqual(vetoed?.keywords, ["sample"]);
});

// ---- both scopes -----------------------------------------------------------

test("matchOutputRulesFor — the output's own rules decide first", () => {
  const own: OutputRule[] = [
    { field: "productGroup", op: "contains", keywords: ["shoes"], mode: "include" },
  ];
  const byType: OutputRule[] = [{ field: "productGroup", op: "contains", keywords: ["sock"] }];

  const shoe = matchOutputRulesFor(own, byType, resolver({ productGroup: "Shoes" }));
  assert.equal(shoe, null);

  const sock = matchOutputRulesFor(own, byType, resolver({ productGroup: "Socks" }));
  assert.equal(sock?.scope, "output");
  assert.equal(sock?.hit.mode, "include");
});

test("matchOutputRulesFor — the doc type still gates an output with no rules", () => {
  const byType: OutputRule[] = [{ field: "productGroup", op: "contains", keywords: ["sock"] }];
  const hit = matchOutputRulesFor(undefined, byType, resolver({ productGroup: "Wool Socks" }));
  assert.equal(hit?.scope, "docType");
  assert.equal(hit?.hit.mode, "exclude");
  assert.equal(matchOutputRulesFor(undefined, byType, resolver({ productGroup: "Shoes" })), null);
});

test("parseOutputRules — drops malformed entries, blank keywords, defaults the mode", () => {
  const parsed = parseOutputRules([
    { field: "productGroup", op: "contains", keywords: ["shoes", "", "  sock  "] },
    { field: "", op: "contains", keywords: ["x"] }, // no field → dropped
    { field: "colourName", op: "equals", keywords: [] }, // no keywords → dropped
    { field: "targetGroup", op: "weird", keywords: ["kids"] }, // bad op → defaults to contains
    { field: "trims", op: "contains", keywords: ["zip"], mode: "include" },
    { field: "description", op: "contains", keywords: ["x"], mode: "nonsense" }, // → exclude
    "garbage",
  ]);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[0], {
    field: "productGroup",
    op: "contains",
    keywords: ["shoes", "sock"],
    mode: "exclude",
  });
  assert.deepEqual(parsed[1], {
    field: "targetGroup",
    op: "contains",
    keywords: ["kids"],
    mode: "exclude",
  });
  assert.equal(parsed[2].mode, "include");
  assert.equal(parsed[3].mode, "exclude");
});

test("exclusionReasonText — names field, keywords and the rule's source", () => {
  assert.equal(
    exclusionReasonText(
      { field: "productGroup", op: "contains", mode: "exclude", keywords: ["shoes"] },
      "Wash care",
    ),
    "Not generated — Product group contains “shoes” (Wash care rule)",
  );
  // An include miss reads as the requirement the style didn't meet.
  assert.equal(
    exclusionReasonText(
      { field: "productGroup", op: "contains", mode: "include", keywords: ["shoes"] },
      "Shoe barcode sticker",
    ),
    "Not generated — Product group doesn’t contain “shoes” (Shoe barcode sticker rule)",
  );
  assert.equal(
    exclusionReasonText(
      { field: "productGroup", op: "equals", mode: "include", keywords: ["Shoes", "Boots"] },
      "Shoe barcode sticker",
    ),
    "Not generated — Product group isn’t “Shoes” or “Boots” (Shoe barcode sticker rule)",
  );
});

test("ruleSentence — reads back what the editor built", () => {
  assert.equal(
    ruleSentence({ field: "productGroup", op: "contains", keywords: ["shoes"], mode: "include" }),
    "Only when Product group contains “shoes”",
  );
  assert.equal(
    ruleSentence({ field: "productGroup", op: "equals", keywords: ["Socks"] }),
    "Never when Product group is “Socks”",
  );
});
