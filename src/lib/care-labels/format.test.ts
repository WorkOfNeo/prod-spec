import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalizeCarePhrase, sanitizeCareInstructions } from "./format";

test("capitalizeCarePhrase uppercases the first letter only", () => {
  assert.equal(capitalizeCarePhrase("machine wash cold"), "Machine wash cold");
  assert.equal(capitalizeCarePhrase("Do not bleach"), "Do not bleach"); // already capital
  assert.equal(capitalizeCarePhrase("  iron low  "), "Iron low"); // trims fragments
  assert.equal(capitalizeCarePhrase("æblegrøn dyes may run"), "Æblegrøn dyes may run"); // non-ASCII
});

test("capitalizeCarePhrase leaves non-letter starts and blanks alone", () => {
  assert.equal(capitalizeCarePhrase("30° wash"), "30° wash");
  assert.equal(capitalizeCarePhrase(""), "");
  assert.equal(capitalizeCarePhrase("   "), "");
});

test("sanitizeCareInstructions capitalizes EVERY instruction in the line", () => {
  assert.equal(
    sanitizeCareInstructions("machine wash 30° / do not bleach / iron low / dry flat"),
    "Machine wash 30° / Do not bleach / Iron low / Dry flat",
  );
});

test("sanitizeCareInstructions handles a single instruction", () => {
  assert.equal(sanitizeCareInstructions("hand wash only"), "Hand wash only");
});

test("sanitizeCareInstructions splits free-text overrides on newlines too", () => {
  assert.equal(
    sanitizeCareInstructions("machine wash cold\ndo not tumble dry"),
    "Machine wash cold / Do not tumble dry",
  );
});

test("sanitizeCareInstructions does not split a bare slash inside a phrase", () => {
  // "inside/out" has no surrounding spaces — it is one instruction, not two.
  assert.equal(sanitizeCareInstructions("wash inside/out"), "Wash inside/out");
});

test("sanitizeCareInstructions is idempotent and safe on empty input", () => {
  const once = sanitizeCareInstructions("machine wash / do not bleach");
  assert.equal(sanitizeCareInstructions(once), once);
  assert.equal(sanitizeCareInstructions(""), "");
  assert.equal(sanitizeCareInstructions(null), "");
  assert.equal(sanitizeCareInstructions(undefined), "");
});
