import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTicketComment } from "./thread";

test("a single comment is one entry with no stamp", () => {
  assert.deepEqual(splitTicketComment("Logo is too small"), [{ stamp: null, text: "Logo is too small" }]);
});

test("re-rejections split into their own entries, oldest first", () => {
  const comment =
    "Logo is too small\n\n— re-rejected 12 Oct 2026, 14:03 —\nStill too small\n\n— re-rejected 14 Oct 2026, 09:10 —\nAnd the EAN is wrong";
  assert.deepEqual(splitTicketComment(comment), [
    { stamp: null, text: "Logo is too small" },
    { stamp: "12 Oct 2026, 14:03", text: "Still too small" },
    { stamp: "14 Oct 2026, 09:10", text: "And the EAN is wrong" },
  ]);
});

test("multi-line comments keep their line breaks", () => {
  const comment = "Line one\nLine two\n\n— re-rejected 12 Oct 2026, 14:03 —\nA\nB";
  assert.deepEqual(splitTicketComment(comment), [
    { stamp: null, text: "Line one\nLine two" },
    { stamp: "12 Oct 2026, 14:03", text: "A\nB" },
  ]);
});

test("empty pieces are dropped", () => {
  assert.deepEqual(splitTicketComment("  "), []);
});
