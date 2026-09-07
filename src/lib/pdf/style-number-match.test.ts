// The style-number → style row decision behind the single-style General
// information regenerate. The property under test throughout is that this
// NEVER silently picks one row out of several: the action it gates rebuilds a
// cover and re-uploads it over the copy a supplier is looking at, so guessing
// the wrong order is not a recoverable mistake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickStyleNumberMatch } from "./style-number-match";

const rows = [
  { id: "s1", name: "IL63378" },
  { id: "s2", name: "IL63378" }, // same number, different PO row — normal here
  { id: "s3", name: "IL633780" }, // longer number that CONTAINS the one above
  { id: "s4", name: "HK60112" },
];

test("a unique exact match resolves without asking", () => {
  const m = pickStyleNumberMatch(rows, "HK60112");
  assert.equal(m.kind, "one");
  assert.equal(m.kind === "one" && m.row.id, "s4");
  assert.equal(m.kind === "one" && m.matchedExactly, true);
});

test("two rows sharing a style number are ambiguous, never auto-picked", () => {
  const m = pickStyleNumberMatch(rows, "IL63378");
  assert.equal(m.kind, "ambiguous", "same number on several PO rows is the normal case here");
  assert.deepEqual(m.kind === "ambiguous" && m.rows.map((r) => r.id), ["s1", "s2"]);
});

test("an exact match is never diluted by a longer row that merely contains it", () => {
  // IL633780 contains IL63378. If the tiers were merged, typing the shorter
  // number would offer — or worse, pick — a different order entirely.
  const m = pickStyleNumberMatch(rows, "IL63378");
  assert.equal(m.kind, "ambiguous");
  assert.ok(
    m.kind === "ambiguous" && !m.rows.some((r) => r.name === "IL633780"),
    "the contains tier must not run at all once something matched exactly",
  );
});

test("contains is the fallback when nothing matches exactly", () => {
  const m = pickStyleNumberMatch(rows, "633780");
  assert.equal(m.kind, "one");
  assert.equal(m.kind === "one" && m.row.id, "s3");
  assert.equal(m.kind === "one" && m.matchedExactly, false, "caller can warn it was a partial hit");
});

test("a partial hit spanning several rows is ambiguous too", () => {
  const m = pickStyleNumberMatch(rows, "6337");
  assert.equal(m.kind, "ambiguous");
  assert.equal(m.kind === "ambiguous" && m.matchedExactly, false);
  assert.equal(m.kind === "ambiguous" && m.rows.length, 3, "s1, s2 and s3 all contain it");
});

test("whitespace and case are normalised on both sides", () => {
  assert.equal(pickStyleNumberMatch(rows, "  hk60112 ").kind, "one");
  assert.equal(pickStyleNumberMatch([{ id: "x", name: " HK60112 " }], "hk60112").kind, "one");
});

test("no match reports none rather than falling back to anything", () => {
  assert.equal(pickStyleNumberMatch(rows, "ZZ99999").kind, "none");
});

test("an empty or whitespace-only query never matches everything", () => {
  // "".includes() is true for every string — the guard is what stops a blank
  // box from resolving to the whole estate.
  assert.equal(pickStyleNumberMatch(rows, "").kind, "none");
  assert.equal(pickStyleNumberMatch(rows, "   ").kind, "none");
});

test("an empty candidate list is none, not a crash", () => {
  assert.equal(pickStyleNumberMatch([], "IL63378").kind, "none");
});

test("extra fields ride along so the caller can render a picker", () => {
  const withPo = [{ id: "s1", name: "IL63378", poNumber: "PO-1", prodSpecId: "spec-1" }];
  const m = pickStyleNumberMatch(withPo, "IL63378");
  assert.equal(m.kind === "one" && m.row.poNumber, "PO-1");
  assert.equal(m.kind === "one" && m.row.prodSpecId, "spec-1");
});
