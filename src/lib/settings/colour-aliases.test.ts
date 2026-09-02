import { test, before } from "node:test";
import assert from "node:assert/strict";

// app-settings.ts imports the Prisma client at module load; nothing here
// queries — set a dummy URL so the module loads. (Same shim as the layout tests.)
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let normalizeColourAliases: typeof import("./app-settings").normalizeColourAliases;

before(async () => {
  ({ normalizeColourAliases } = await import("./app-settings"));
});

// The store is the guard rail: the row is hand-editable and the screen posts
// free text, so anything that can't bridge two spellings must not survive.

test("keeps a well-formed group", () => {
  assert.deepEqual(normalizeColourAliases([["LGM", "Grey melange"]]), [["LGM", "Grey melange"]]);
});

test("drops a group with fewer than two spellings — it bridges nothing", () => {
  assert.deepEqual(normalizeColourAliases([["LGM"], [], ["A", "B"]]), [["A", "B"]]);
});

test("trims, and de-dupes case-insensitively (which collapses a useless group)", () => {
  assert.deepEqual(normalizeColourAliases([["  LGM  ", "Grey melange"]]), [["LGM", "Grey melange"]]);
  // "grey melange" already matches "Grey melange" — matching ignores case, so a
  // group of the two is not a bridge and shouldn't pretend to be one.
  assert.deepEqual(normalizeColourAliases([["Grey melange", "grey melange"]]), []);
});

test("survives a stale or hand-edited row without throwing", () => {
  assert.deepEqual(normalizeColourAliases(null), []);
  assert.deepEqual(normalizeColourAliases("nope"), []);
  assert.deepEqual(normalizeColourAliases([null, 42, ["A", 7, "B"]]), [["A", "B"]]);
});

test("caps group count and group size", () => {
  const many = Array.from({ length: 400 }, (_, i) => [`a${i}`, `b${i}`]);
  assert.equal(normalizeColourAliases(many).length, 200);
  const wide = [Array.from({ length: 40 }, (_, i) => `c${i}`)];
  assert.equal(normalizeColourAliases(wide)[0].length, 12);
});
