import { test } from "node:test";
import assert from "node:assert/strict";
import {
  batches,
  chunk,
  deleteUniqueClashes,
  qi,
  rowsGoneFromProd,
  rowsToCopy,
  sameDatabase,
  selectList,
  sharedColumns,
  upsertFromStaging,
  valuesClause,
  type Column,
} from "./sql";

const cols: Column[] = [
  { name: "id", type: "text" },
  { name: "status", type: '"StyleStatus"' },
  { name: "rawData", type: "jsonb" },
  { name: "pdf", type: "bytea" },
];

test("qi quotes identifiers and escapes embedded quotes", () => {
  assert.equal(qi("poNumber"), '"poNumber"');
  assert.equal(qi('we"ird'), '"we""ird"');
});

test("sharedColumns keeps dev order and drops columns production lacks", () => {
  const prod: Column[] = [{ name: "rawData", type: "jsonb" }, { name: "id", type: "text" }];
  assert.deepEqual(
    sharedColumns(cols, prod).map((c) => c.name),
    ["id", "rawData"],
  );
});

test("selectList reads as text except bytea", () => {
  assert.equal(
    selectList(cols),
    '"id"::text AS "id", "status"::text AS "status", "rawData"::text AS "rawData", "pdf"',
  );
});

test("valuesClause casts every value back to its column type", () => {
  assert.equal(
    valuesClause(cols.slice(0, 2), 2),
    '($1::text, $2::"StyleStatus"), ($3::text, $4::"StyleStatus")',
  );
});

test("upsertFromStaging overwrites every copied column but the key", () => {
  assert.equal(
    upsertFromStaging("styles", cols.slice(0, 2), "id", "_in"),
    'INSERT INTO "styles" ("id", "status") SELECT "id", "status" FROM "_in" ON CONFLICT ("id") DO UPDATE SET "status" = EXCLUDED."status"',
  );
  assert.match(upsertFromStaging("t", [{ name: "id", type: "text" }], "id", "_in"), /DO NOTHING$/);
});

test("deleteUniqueClashes removes a different row holding the same unique value", () => {
  assert.equal(
    deleteUniqueClashes("users", ["email"], "id", "_in"),
    'DELETE FROM "users" t USING "_in" s WHERE t."email" = s."email" AND t."id" <> s."id"',
  );
});

test("batches respects the parameter limit", () => {
  const rows = Array.from({ length: 10 }, (_, i) => [i, i, i] as unknown[]);
  const out = batches(rows, { maxParams: 9 });
  assert.deepEqual(out.map((b) => b.length), [3, 3, 3, 1]);
});

test("batches respects the byte budget for PDFs", () => {
  const pdf = Buffer.alloc(600);
  const rows = [["a", pdf], ["b", pdf], ["c", pdf]] as unknown[][];
  assert.deepEqual(batches(rows, { maxBytes: 1000 }).map((b) => b.length), [1, 1, 1]);
  // A single row over the budget still goes out on its own.
  assert.deepEqual(batches([["x", Buffer.alloc(5000)]] as unknown[][], { maxBytes: 1000 }).length, 1);
});

test("chunk splits a list", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
});

test("rowsToCopy: new rows and rows production changed, nothing else", () => {
  const prod = new Map<string, string | null>([
    ["new", "2026-10-24T10:00:00.000000"],
    ["changed", "2026-10-24T12:00:00.000000"],
    ["same", "2026-10-24T09:00:00.000000"],
  ]);
  const ledger = new Map<string, string | null>([
    ["changed", "2026-10-24T11:00:00.000000"],
    ["same", "2026-10-24T09:00:00.000000"],
  ]);
  assert.deepEqual(rowsToCopy(prod, ledger), ["new", "changed"]);
});

test("rowsToCopy: append-only tables copy new keys only", () => {
  const prod = new Map<string, string | null>([["a", null], ["b", null]]);
  const ledger = new Map<string, string | null>([["a", null]]);
  assert.deepEqual(rowsToCopy(prod, ledger), ["b"]);
});

test("rowsGoneFromProd: ledger keys production deleted", () => {
  const prod = new Map<string, string | null>([["a", null]]);
  const ledger = new Map<string, string | null>([["a", null], ["gone", null]]);
  assert.deepEqual(rowsGoneFromProd(prod, ledger), ["gone"]);
});

test("sameDatabase compares host, port and database name", () => {
  const prod = "postgresql://u:p@kodama.proxy.rlwy.net:19163/railway?sslmode=require";
  assert.equal(sameDatabase(prod, "postgresql://reader:x@KODAMA.proxy.rlwy.net:19163/railway"), true);
  assert.equal(sameDatabase(prod, "postgresql://postgres:x@postgres.railway.internal:5432/railway"), false);
  assert.equal(sameDatabase(prod, "postgresql://u:p@kodama.proxy.rlwy.net:19163/other"), false);
  // Unparseable fails closed.
  assert.equal(sameDatabase(prod, "not a url"), true);
});
