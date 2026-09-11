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

// =====================================================
// Numeric ops (gt/lt) — built so ONE layout can split into a priced and an
// unpriced output. The pair that does it:
//   priced   → "Generate when Price is greater than 0"
//   unpriced → "Don't generate when Price is greater than 0"
// Everything below exists to keep that pair total: every style must land in
// exactly one of the two, including the ones with no readable price.
// =====================================================

test("gt/lt — compares the amount, not the text", () => {
  const gt: OutputRule[] = [{ field: "price", op: "gt", keywords: ["0"] }];
  assert.ok(matchOutputRules(gt, resolver({ price: "69,95" })));
  assert.ok(matchOutputRules(gt, resolver({ price: "0,01" })));
  assert.equal(matchOutputRules(gt, resolver({ price: "0" })), null);
  assert.equal(matchOutputRules(gt, resolver({ price: "0,00" })), null);

  const lt: OutputRule[] = [{ field: "price", op: "lt", keywords: ["100"] }];
  assert.ok(matchOutputRules(lt, resolver({ price: "69,95" })));
  // Text ops would compare "1.299,95" as a string and call it less than "100".
  assert.equal(matchOutputRules(lt, resolver({ price: "1.299,95" })), null);
});

test("gt — reads the messy live formats the price token reads", () => {
  const rules: OutputRule[] = [{ field: "price", op: "gt", keywords: ["0"] }];
  for (const price of ["KR 69,95", "Kr. 39,00", "129.95 DKK", "PER SÆT:KR 129,95", "1.299,95"]) {
    assert.ok(matchOutputRules(rules, resolver({ price })), price);
  }
});

test("gt/lt — an unreadable price matches NEITHER direction", () => {
  // The load-bearing case. A blank price, "See customer order" (100 live
  // styles) and a dual-market value all print nothing via {{price}}, so a
  // numeric rule must not treat them as 0 — otherwise "Price is less than
  // 999" would put a priced label on a style with no price on it.
  for (const price of ["", "See customer order", "99 SEK, 69 DKK"]) {
    const gt: OutputRule[] = [{ field: "price", op: "gt", keywords: ["0"] }];
    const lt: OutputRule[] = [{ field: "price", op: "lt", keywords: ["999"] }];
    assert.equal(matchOutputRules(gt, resolver({ price })), null, `gt: ${price}`);
    assert.equal(matchOutputRules(lt, resolver({ price })), null, `lt: ${price}`);
  }
});

test("gt — the include/exclude pair covers every style exactly once", () => {
  const priced: OutputRule[] = [
    { field: "price", op: "gt", keywords: ["0"], mode: "include" },
  ];
  const unpriced: OutputRule[] = [
    { field: "price", op: "gt", keywords: ["0"], mode: "exclude" },
  ];
  // A real price: the priced output generates, the unpriced one is skipped.
  const withPrice = resolver({ price: "KR 69,95" });
  assert.equal(matchOutputRules(priced, withPrice), null);
  assert.ok(matchOutputRules(unpriced, withPrice));

  // No price at all — the whole point of the exercise: the unpriced output
  // STILL generates, and the priced one is the one held back.
  for (const price of ["", "0", "See customer order"]) {
    const r = resolver({ price });
    assert.ok(matchOutputRules(priced, r), `priced skipped: ${price}`);
    assert.equal(matchOutputRules(unpriced, r), null, `unpriced skipped: ${price}`);
  }
});

test("numeric rules — a threshold that isn't a number decides nothing", () => {
  const rules: OutputRule[] = [{ field: "price", op: "gt", keywords: ["free"] }];
  assert.equal(matchOutputRules(rules, resolver({ price: "69,95" })), null);
});

test("numeric ops — wording reads as English", () => {
  assert.equal(
    ruleSentence({ field: "price", op: "gt", keywords: ["0"], mode: "include" }),
    "Only when Price is greater than “0”",
  );
  assert.equal(
    ruleSentence({ field: "price", op: "gt", keywords: ["0"], mode: "exclude" }),
    "Never when Price is greater than “0”",
  );
  assert.equal(
    exclusionReasonText(
      { field: "price", op: "gt", mode: "include", keywords: ["0"] },
      "Price sticker",
    ),
    "Not generated — Price isn’t greater than “0” (Price sticker rule)",
  );
  assert.equal(
    exclusionReasonText(
      { field: "price", op: "lt", mode: "exclude", keywords: ["100"] },
      "Price sticker",
    ),
    "Not generated — Price is less than “100” (Price sticker rule)",
  );
});

test("parseOutputRules — round-trips the numeric ops, defaults junk to contains", () => {
  const parsed = parseOutputRules([
    { field: "price", op: "gt", keywords: ["0"], mode: "include" },
    { field: "price", op: "lt", keywords: ["100"], mode: "exclude" },
    { field: "price", op: "nonsense", keywords: ["0"] },
  ]);
  assert.equal(parsed[0].op, "gt");
  assert.equal(parsed[1].op, "lt");
  assert.equal(parsed[2].op, "contains");
});

// =====================================================
// Presence ops (empty/notEmpty) — "is this field filled in?". Added because
// the two-include-rule pair an operator naturally reaches for
//   priced   → Generate when Price is greater than 1
//   unpriced → Generate when Price is less than 1
// leaves styles that match NEITHER, and those get no output at all. A
// missing price is the big one; an exact 1 is the other.
// =====================================================

test("empty/notEmpty — test presence, nothing else", () => {
  const isSet: OutputRule[] = [{ field: "price", op: "notEmpty", keywords: [] }];
  const notSet: OutputRule[] = [{ field: "price", op: "empty", keywords: [] }];

  // A real amount is "set" — 0 included, it IS a price.
  for (const price of ["69,95", "0"]) {
    assert.ok(matchOutputRules(isSet, resolver({ price })), `isSet: ${price}`);
    assert.equal(matchOutputRules(notSet, resolver({ price })), null, `notSet: ${price}`);
  }
  // "Not set" covers both kinds of nothing: a blank cell, AND a cell holding
  // text that isn't a price. Both print nothing on the label, so both belong
  // to the unpriced output.
  for (const price of ["", "See customer order", "99 SEK, 69 DKK"]) {
    assert.equal(matchOutputRules(isSet, resolver({ price })), null, `isSet: ${price}`);
    assert.ok(matchOutputRules(notSet, resolver({ price })), `notSet: ${price}`);
  }
});

test("empty — survives the filters that drop a keyword-less rule", () => {
  // usableRules and parseOutputRules both require a keyword for every other
  // op; a presence rule has none and must not be silently discarded.
  const parsed = parseOutputRules([{ field: "price", op: "empty", keywords: [], mode: "include" }]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].op, "empty");
  // A satisfied include returns null (= generate).
  assert.equal(matchOutputRules(parsed, resolver({ price: "" })), null);
  // And it must still DECIDE when unsatisfied — a dropped rule would leave
  // usableRules empty and return null here too, which is the failure this
  // test is actually guarding against.
  assert.ok(matchOutputRules(parsed, resolver({ price: "69,95" })));
});

test("empty — ORs with a numeric rule to close the gap", () => {
  // The fix for the real case: "less than 1 OR not set at all". Include rules
  // are alternatives, so the two rules compose without any new syntax.
  const unpriced: OutputRule[] = [
    { field: "price", op: "lt", keywords: ["1"], mode: "include" },
    { field: "price", op: "empty", keywords: [], mode: "include" },
  ];
  // Generates (rule satisfied → null hit) for every style without a real price.
  for (const price of ["", "0", "0,50"]) {
    assert.equal(matchOutputRules(unpriced, resolver({ price })), null, `unpriced: ${price}`);
  }
  // And still stays off the styles that DO have one.
  assert.ok(matchOutputRules(unpriced, resolver({ price: "69,95" })));
});

test("presence ops — wording carries no value", () => {
  assert.equal(
    ruleSentence({ field: "price", op: "empty", keywords: [], mode: "include" }),
    "Only when Price isn’t set",
  );
  assert.equal(
    ruleSentence({ field: "price", op: "notEmpty", keywords: [], mode: "exclude" }),
    "Never when Price is set",
  );
  // An unmet "only when not set" means the style HAS a price — say that,
  // and never leak the internal presence marker or an empty “”.
  const reason = exclusionReasonText(
    { field: "price", op: "empty", mode: "include", keywords: [] },
    "Price sticker",
  );
  assert.equal(reason, "Not generated — Price is set (Price sticker rule)");
  assert.ok(!reason.includes("__present__"));
  assert.ok(!reason.includes("“”"));
});

test("presence ops — the exclude direction doesn't leak the marker either", () => {
  const hit = matchOutputRules(
    [{ field: "price", op: "notEmpty", keywords: [], mode: "exclude" }],
    resolver({ price: "69,95" }),
  );
  assert.deepEqual(hit?.keywords, []);
  assert.equal(
    exclusionReasonText(hit!, "Unpriced sticker"),
    "Not generated — Price is set (Unpriced sticker rule)",
  );
});

test("presence — a non-price field is just blank-or-not", () => {
  const isSet: OutputRule[] = [{ field: "trims", op: "notEmpty", keywords: [] }];
  // Text that would be nonsense as a price is a perfectly good trims value.
  assert.ok(matchOutputRules(isSet, resolver({ trims: "See customer order" })));
  assert.equal(matchOutputRules(isSet, resolver({ trims: "" })), null);
});
