import { test } from "node:test";
import assert from "node:assert/strict";
import { comparePoDesc, sortByPoDesc, type PoSortableRow } from "./table-sort";

// A row shaped like the table's, plus its display PO so the assertions read
// like the screen does.
type Row = PoSortableRow & { poNumber: string | null };

const row = (poNumber: string | null, poSeq: number | null, updatedAtIso = "2026-01-01T00:00:00.000Z"): Row => ({
  poNumber,
  poSeq,
  updatedAtIso,
});

// ---------------------------------------------------------------------------
// The case that motivated the whole change: sorting the PO *string* descending
// puts "C-PO9" above "C-PO12345" (lexicographic: '9' > '6'), so the reviewer's
// list opened on an ancient order. poSeq is the parsed number, so it doesn't.
// ---------------------------------------------------------------------------
test("C-PO9 sorts BELOW C-PO12345 — a string sort would invert them", () => {
  const rows = [row("C-PO9", 9), row("C-PO12345", 12345), row("C-PO12000", 63320)];

  const byString = [...rows].sort((a, b) => (b.poNumber ?? "").localeCompare(a.poNumber ?? ""));
  assert.equal(byString[0].poNumber, "C-PO9", "sanity: a string sort really does put C-PO9 first");

  const sorted = sortByPoDesc(rows);
  assert.deepEqual(
    sorted.map((r) => r.poNumber),
    ["C-PO12345", "C-PO12000", "C-PO9"],
  );
});

test("largest PO first", () => {
  const sorted = sortByPoDesc([row("C-PO100", 100), row("C-PO12345", 12345), row("C-PO2000", 2000)]);
  assert.deepEqual(
    sorted.map((r) => r.poSeq),
    [12345, 2000, 100],
  );
});

test("rows with no parsed PO sink to the bottom", () => {
  const sorted = sortByPoDesc([
    row(null, null),
    row("C-PO12345", 12345),
    row("Navision task", null),
    row("C-PO7", 7),
  ]);
  assert.deepEqual(
    sorted.map((r) => r.poSeq),
    [12345, 7, null, null],
  );
});

test("same PO: most recently updated first", () => {
  const older = row("C-PO12345", 12345, "2026-08-01T09:00:00.000Z");
  const newer = row("C-PO12345", 12345, "2026-08-12T09:00:00.000Z");
  assert.deepEqual(sortByPoDesc([older, newer]), [newer, older]);
  // …and the same tiebreak applies to two PO-less rows.
  const a = row(null, null, "2026-08-01T09:00:00.000Z");
  const b = row(null, null, "2026-08-12T09:00:00.000Z");
  assert.deepEqual(sortByPoDesc([a, b]), [b, a]);
});

test("without a timestamp, same-PO rows keep their incoming order (stable)", () => {
  // The table ships formatted dates, not ISO ones, so the comparator sees no
  // tiebreak — the server's own poSeq/updatedAt order has to survive.
  const first = { poNumber: "C-PO12345", poSeq: 12345 };
  const second = { poNumber: "C-PO12345", poSeq: 12345 };
  const third = { poNumber: "C-PO9", poSeq: 9 };
  assert.deepEqual(sortByPoDesc([first, second, third]), [first, second, third]);
});

test("comparator is a total order (no zero for distinct rows)", () => {
  assert.ok(comparePoDesc(row("A", 2), row("B", 1)) < 0);
  assert.ok(comparePoDesc(row("A", 1), row("B", 2)) > 0);
  assert.equal(comparePoDesc(row("A", 1), row("B", 1)), 0);
});

test("sort does not mutate the caller's array", () => {
  const rows = [row("C-PO9", 9), row("C-PO12345", 12345)];
  const snapshot = rows.map((r) => r.poNumber);
  sortByPoDesc(rows);
  assert.deepEqual(
    rows.map((r) => r.poNumber),
    snapshot,
  );
});
