// Pure-logic tests for the PO-folder matcher + resolver — the app searches the
// supplier's folder for the PO folder and never creates it, so getting the
// match (and the multiple-match policy) right is what keeps files out of the
// wrong folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { folderMatchesPo, resolvePoFolder, type ChildFolder } from "./supplier-folder";

const f = (name: string): ChildFolder => ({ id: name, name, webUrl: `https://x/${name}`, childCount: 1 });

test("folderMatchesPo — matches the PO as a token, not a digit-glued substring", () => {
  assert.equal(folderMatchesPo("C-PO63359 - Netto - Leadtime", "C-PO63359"), true);
  assert.equal(folderMatchesPo("C-PO63359 - Netto", "c-po63359"), true, "case-insensitive");
  // Bare-digit PO must not match a longer number containing it.
  assert.equal(folderMatchesPo("C-PO63590", "635"), false);
  assert.equal(folderMatchesPo("Order 635 spring", "635"), true, "digit token bounded by spaces");
  assert.equal(folderMatchesPo("635901", "635"), false, "635 is a prefix of 635901 → no match");
  assert.equal(folderMatchesPo("anything", ""), false, "empty PO never matches");
  assert.equal(folderMatchesPo("C-PO1 - x", "C-PO2"), false);
});

test("resolvePoFolder — no PO number is 'missing' (can't identify a folder)", () => {
  assert.deepEqual(resolvePoFolder([f("C-PO1 - a")], null, "C-PO1 - a"), { status: "missing" });
  assert.deepEqual(resolvePoFolder([f("C-PO1 - a")], "   ", "C-PO1 - a"), { status: "missing" });
});

test("resolvePoFolder — zero matches is 'missing'", () => {
  const res = resolvePoFolder([f("C-PO999 - a"), f("misc")], "C-PO1", "C-PO1 - Cust - Sup");
  assert.equal(res.status, "missing");
});

test("resolvePoFolder — exactly one match is 'found'", () => {
  const res = resolvePoFolder([f("C-PO1 - Cust - Sup"), f("C-PO2 - other")], "C-PO1", "C-PO1 - Cust - Sup");
  assert.equal(res.status, "found");
  assert.equal(res.status === "found" && res.folder.name, "C-PO1 - Cust - Sup");
});

test("resolvePoFolder — several matches: the exact app name breaks the tie", () => {
  const children = [f("C-PO1 - Cust - Sup"), f("C-PO1 old")];
  const res = resolvePoFolder(children, "C-PO1", "C-PO1 - Cust - Sup");
  assert.equal(res.status, "found");
  assert.equal(res.status === "found" && res.folder.name, "C-PO1 - Cust - Sup");
});

test("resolvePoFolder — several matches, no exact name → 'ambiguous' (never guess)", () => {
  const children = [f("C-PO1 - typo"), f("C-PO1 (copy)")];
  const res = resolvePoFolder(children, "C-PO1", "C-PO1 - Cust - Sup");
  assert.equal(res.status, "ambiguous");
  assert.equal(res.status === "ambiguous" && res.matches.length, 2);
});
