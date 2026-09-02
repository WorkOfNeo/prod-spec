import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  suggestFix,
  describeSuggestion,
  type RepetitionRow,
} from "./filename-collision-rules";

// The collision report exists to answer one question — "which token would
// separate these documents?" — so these tests pin the ANSWER, not the plumbing.

function row(partial: Partial<RepetitionRow> & { suffix: string }): RepetitionRow {
  return {
    size: "",
    colourName: "",
    compositionColour: "",
    ean13: "",
    cartonEan: "",
    fileName: null,
    ...partial,
  };
}

test("size alone separates rows that differ only by size", () => {
  const rows = [
    row({ suffix: "S", size: "S", colourName: "Blue", ean13: "111" }),
    row({ suffix: "M", size: "M", colourName: "Blue", ean13: "222" }),
  ];
  assert.deepEqual(suggestFix(rows), ["size"]);
});

test("falls through to colour when the size repeats", () => {
  const rows = [
    row({ suffix: "S-bl", size: "S", colourName: "Blue", ean13: "111" }),
    row({ suffix: "S-rd", size: "S", colourName: "Red", ean13: "222" }),
  ];
  assert.deepEqual(suggestFix(rows), ["size", "colourName"]);
});

// The production case: Kaufland / Netto rows carry the same size AND the same
// placeholder colour ("Colour A") and differ only by EAN.
test("falls through to the EAN when size and colour are both identical", () => {
  const rows = [
    row({ suffix: "110116-ColourA", size: "110/116", colourName: "Colour A", ean13: "5706323559212" }),
    row({ suffix: "110116-ColourA-2", size: "110/116", colourName: "Colour A", ean13: "5706323559373" }),
  ];
  assert.deepEqual(suggestFix(rows), ["size", "colourName", "ean13"]);
});

test("no suggestion when the rows are identical in every token", () => {
  const rows = [
    row({ suffix: "S-bl", size: "S", colourName: "Blue", ean13: "111" }),
    row({ suffix: "S-bl-2", size: "S", colourName: "Blue", ean13: "111" }),
  ];
  assert.equal(suggestFix(rows), null);
});

// A separator-joined key would let ["A B","C"] and ["A","B C"] collapse into
// the same string and under-report a genuine collision.
test("token values containing spaces do not alias into one key", () => {
  const rows = [
    row({ suffix: "a", size: "A B", colourName: "C" }),
    row({ suffix: "b", size: "A", colourName: "B C" }),
  ];
  assert.deepEqual(suggestFix(rows), ["size"]);
});

test("the fix names only the tokens the expression is MISSING", () => {
  const suggestion = ["size", "colourName", "ean13"] as const;
  const text = describeSuggestion([...suggestion], "{{styleNumber}}, {{colourName}}, Washcare, {{size}}");
  assert.match(text, /Add \{\{ean13\}\} to the file name\./);
  assert.doesNotMatch(text, /\{\{size\}\}/);
});

test("an expression already carrying every needed token points at the data", () => {
  const text = describeSuggestion(["size"], "{{styleNumber}}-{{size}}");
  assert.match(text, /already in the name/);
});

test("an unsolvable collision is named as a data problem", () => {
  assert.match(describeSuggestion(null, "{{size}}"), /data problem/);
});
