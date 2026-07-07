import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFolderMatches } from "./po-folder-matches";

test("parseFolderMatches — round-trips the stored list", () => {
  const raw = JSON.stringify([
    { name: "C-PO1 - a", webUrl: "https://x/a" },
    { name: "C-PO1 - b", webUrl: null },
  ]);
  assert.deepEqual(parseFolderMatches(raw), [
    { name: "C-PO1 - a", webUrl: "https://x/a" },
    { name: "C-PO1 - b", webUrl: null },
  ]);
});

test("parseFolderMatches — null / empty / garbage → [] (never throws)", () => {
  assert.deepEqual(parseFolderMatches(null), []);
  assert.deepEqual(parseFolderMatches(undefined), []);
  assert.deepEqual(parseFolderMatches(""), []);
  assert.deepEqual(parseFolderMatches("not json"), []);
  assert.deepEqual(parseFolderMatches('{"not":"an array"}'), []);
});

test("parseFolderMatches — drops entries without a name, coerces bad webUrl to null", () => {
  const raw = JSON.stringify([{ name: "ok" }, { webUrl: "https://x" }, { name: "y", webUrl: 5 }]);
  assert.deepEqual(parseFolderMatches(raw), [
    { name: "ok", webUrl: null },
    { name: "y", webUrl: null },
  ]);
});
