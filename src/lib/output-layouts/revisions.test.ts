import { test, before } from "node:test";
import assert from "node:assert/strict";

// revisions.ts imports @/lib/db, whose client construction needs DATABASE_URL
// at import time. Nothing here queries — these are the pure decisions only
// (the DB orchestration is tested with module mocks in
// tests/output-layout-revisions.test.ts).
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let mod: typeof import("./revisions");
before(async () => {
  mod = await import("./revisions");
});

// Synthetic 50×60 mm sticker.
function layout(lines: string[], extra: Record<string, unknown> = {}) {
  return {
    pages: [
      {
        id: "p1",
        widthMm: 50,
        heightMm: 60,
        gridCols: 12,
        gridRows: 15,
        blocks: [{ id: "b1", rect: { col: 0, row: 0, colSpan: 12, rowSpan: 2 }, lines }],
        ...extra,
      },
    ],
  };
}

test("nextRevisionNumber starts at 1 and follows the max", () => {
  assert.equal(mod.nextRevisionNumber(null), 1);
  assert.equal(mod.nextRevisionNumber(undefined), 1);
  assert.equal(mod.nextRevisionNumber(0), 1);
  assert.equal(mod.nextRevisionNumber(7), 8);
});

test("definitionsEqual ignores key order but not array order", () => {
  assert.equal(mod.definitionsEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true);
  assert.equal(mod.definitionsEqual({ a: [1, 2] }, { a: [2, 1] }), false);
  assert.equal(mod.definitionsEqual(layout(["X"]), layout(["X"])), true);
  assert.equal(mod.definitionsEqual(layout(["X"]), layout(["Y"])), false);
});

test("definitionsEqual treats undefined keys as absent, like JSON does", () => {
  assert.equal(mod.definitionsEqual({ a: 1, b: undefined }, { a: 1 }), true);
  assert.equal(mod.definitionsEqual({ a: 1 }, { a: 1, b: null }), false, "null is a value, undefined is not");
});

test("definitionsEqual distinguishes types", () => {
  assert.equal(mod.definitionsEqual(1, "1"), false);
  assert.equal(mod.definitionsEqual([], {}), false);
  assert.equal(mod.definitionsEqual(null, {}), false);
  assert.equal(mod.definitionsEqual({}, {}), true);
  assert.equal(mod.definitionsEqual({ constructor: 1 }, {}), false);
});

test("detectConflict: nothing moved → null", () => {
  const base = layout(["{{styleNumber}}"]);
  assert.equal(mod.detectConflict(structuredClone(base), 3, { baseDefinition: base, baseVersion: 3 }), null);
});

test("detectConflict: a builder autosave (same version, new definition) is a conflict", () => {
  const base = layout(["{{styleNumber}}"]);
  const c = mod.detectConflict(layout(["{{styleNumber}} edited"]), 3, { baseDefinition: base, baseVersion: 3 });
  assert.deepEqual(c, { baseVersion: 3, liveVersion: 3, versionChanged: false, definitionChanged: true });
  assert.match(mod.describeConflict(c!), /edited in the Output Builder/);
});

test("detectConflict: a publish in between is a conflict even with an equal definition", () => {
  const base = layout(["{{styleNumber}}"]);
  const c = mod.detectConflict(structuredClone(base), 4, { baseDefinition: base, baseVersion: 3 });
  assert.deepEqual(c, { baseVersion: 3, liveVersion: 4, versionChanged: true, definitionChanged: false });
  assert.match(mod.describeConflict(c!), /published again \(version 3 → 4\)/);
});

test("detectConflict: both moved", () => {
  const c = mod.detectConflict(layout(["B"]), 5, { baseDefinition: layout(["A"]), baseVersion: 3 });
  assert.equal(c?.versionChanged, true);
  assert.equal(c?.definitionChanged, true);
  assert.match(mod.describeConflict(c!), /and its definition changed/);
});

test("RevisionConflictError carries what changed and a 409", () => {
  const conflict = { baseVersion: 1, liveVersion: 2, versionChanged: true, definitionChanged: false };
  const err = new mod.RevisionConflictError(conflict);
  assert.equal(err.httpStatus, 409);
  assert.deepEqual(err.conflict, conflict);
  assert.ok(err instanceof Error);
});

test("parseDraftDefinition never turns garbage into the starter layout", () => {
  for (const raw of [null, undefined, "x", [], {}, { foo: 1 }]) {
    const res = mod.parseDraftDefinition(raw);
    assert.equal(res.ok, false, `input ${JSON.stringify(raw)}`);
  }
  const bad = mod.parseDraftDefinition({ pages: [] });
  assert.equal(bad.ok, false, "schema still applies");
});

test("parseDraftDefinition normalises a legacy layout (block ids, margins)", () => {
  const legacy = {
    pages: [
      {
        id: "p1",
        widthMm: 50,
        heightMm: 60,
        marginMm: 2,
        blocks: [{ rect: { col: 0, row: 0, colSpan: 6, rowSpan: 2 }, lines: ["{{styleNumber}}"] }],
      },
    ],
  };
  const res = mod.parseDraftDefinition(legacy);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.def.pages[0]?.blocks[0]?.id, "b-r0", "deterministic id so ops can address it");
  assert.deepEqual(res.def.pages[0]?.margins, { topMm: 2, rightMm: 2, bottomMm: 2, leftMm: 2 });
});

test("restorableDefinition: base is always restorable", () => {
  for (const status of ["DRAFT", "PUBLISHED", "DISCARDED", "SUPERSEDED"]) {
    const res = mod.restorableDefinition(
      { number: 2, status, definition: { d: 1 }, baseDefinition: { b: 1 } },
      "base",
    );
    assert.deepEqual(res, { ok: true, definition: { b: 1 } });
  }
});

test("restorableDefinition: a revision's own definition only if it was published", () => {
  const ok = mod.restorableDefinition(
    { number: 2, status: "PUBLISHED", definition: { d: 1 }, baseDefinition: { b: 1 } },
    "definition",
  );
  assert.deepEqual(ok, { ok: true, definition: { d: 1 } });
  for (const status of ["DRAFT", "DISCARDED", "SUPERSEDED"]) {
    const res = mod.restorableDefinition(
      { number: 2, status, definition: { d: 1 }, baseDefinition: { b: 1 } },
      "definition",
    );
    assert.equal(res.ok, false, status);
  }
});
