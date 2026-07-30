import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COLUMN_MAPPING, type ColumnMapping } from "@/lib/customers/config";
import {
  buildLookalikeChips,
  findLookalikes,
  lookalikeConfidence,
  type LookalikeChipRow,
  type LookalikeSourceRow,
} from "./related";

// ---------------------------------------------------------------------------
// The reported incident, as a test: Monday held TWO Pre-Order rows with the
// EXACT same style name, one per PO (C-PO63018 / C-PO63394), each covering a
// different slice of the size run. The reviewer opened one, counted 3 sizes,
// and reported a style that was in fact perfectly fine. Everything here guards
// the detection of that shape — and, just as importantly, guards against it
// firing when nothing is wrong (a same-PO carton sibling, an unrelated style
// that happens to share a blank consignment code).
// ---------------------------------------------------------------------------

const MAPPING: ColumnMapping = DEFAULT_COLUMN_MAPPING;

// A Monday snapshot carrying only the columns the match keys read.
function raw(cols: { sizes?: string; consignment?: string; itemNo?: string }) {
  return {
    column_values: [
      { id: "sizes__1", text: cols.sizes ?? "" },
      { id: "text99__1", text: cols.consignment ?? "" },
      { id: "text91__1", text: cols.itemNo ?? "" },
    ],
  };
}

function row(over: Partial<LookalikeSourceRow> & { id: string }): LookalikeSourceRow {
  return {
    name: "IL62778I Fleece pants",
    poNumber: "C-PO63018",
    rawData: raw({}),
    eanStatus: "RESOLVED",
    mondayItemId: `monday-${over.id}`,
    ...over,
  };
}

// ── findLookalikes: the per-row (detail card) matcher ──────────────────────

test("the real case: same name, different PO, different size run", () => {
  const subject = row({
    id: "a",
    poNumber: "C-PO63394",
    rawData: raw({ sizes: "27-30, 31-34" }),
  });
  const other = row({
    id: "b",
    poNumber: "C-PO63018",
    rawData: raw({ sizes: "19-22, 23-26, 35-38" }),
  });

  const [match, ...rest] = findLookalikes(subject, [other], MAPPING);
  assert.equal(rest.length, 0);
  assert.equal(match.id, "b");
  assert.equal(match.matchedOn, "name");
  assert.equal(match.confidence, 1);
  assert.equal(match.poNumber, "C-PO63018");
  // The size run is what actually differed in the report — it must survive.
  assert.deepEqual(match.sizes, ["19-22", "23-26", "35-38"]);
  assert.equal(match.eanStatus, "RESOLVED");
  assert.equal(match.mondayItemId, "monday-b");
});

test("same name on the SAME PO is a carton sibling, not a lookalike", () => {
  const subject = row({ id: "a", poNumber: "C-PO63018" });
  const sibling = row({ id: "b", poNumber: "C-PO63018" });
  assert.deepEqual(findLookalikes(subject, [sibling], MAPPING), []);
});

test("same-PO check is whitespace/case tolerant", () => {
  const subject = row({ id: "a", poNumber: "c-po63018" });
  const sibling = row({ id: "b", poNumber: " C-PO63018 " });
  assert.deepEqual(findLookalikes(subject, [sibling], MAPPING), []);
});

test("two rows that both lack a PO are not each other's lookalike", () => {
  const subject = row({ id: "a", poNumber: null });
  const other = row({ id: "b", poNumber: null });
  assert.deepEqual(findLookalikes(subject, [other], MAPPING), []);
});

test("self is excluded even when handed back in the candidate list", () => {
  const subject = row({ id: "a", poNumber: "C-PO63394" });
  const other = row({ id: "b", poNumber: "C-PO63018" });
  const matches = findLookalikes(subject, [subject, other], MAPPING);
  assert.deepEqual(
    matches.map((m) => m.id),
    ["b"],
  );
});

test("duplicate candidates (the two loader reads overlap) yield one match", () => {
  const subject = row({ id: "a", poNumber: "C-PO63394" });
  const other = row({ id: "b", poNumber: "C-PO63018" });
  const matches = findLookalikes(subject, [other, other, other], MAPPING);
  assert.equal(matches.length, 1);
});

test("consignment code matches a renamed row, and is ranked below name", () => {
  const subject = row({
    id: "a",
    name: "IL62778I Fleece pants",
    poNumber: "C-PO63394",
    rawData: raw({ consignment: "ILC01989" }),
  });
  const renamed = row({
    id: "b",
    name: "Fleece pants (rev B)",
    poNumber: "C-PO63018",
    rawData: raw({ consignment: "ILC01989", sizes: "19-22" }),
  });

  const [match] = findLookalikes(subject, [renamed], MAPPING);
  assert.equal(match.matchedOn, "consignmentCode");
  assert.equal(match.confidence, 2);
  assert.deepEqual(match.sizes, ["19-22"]);
});

test("customer item no is the weakest key", () => {
  const subject = row({ id: "a", name: "A", poNumber: "C-PO1", rawData: raw({ itemNo: "42311" }) });
  const other = row({ id: "b", name: "B", poNumber: "C-PO2", rawData: raw({ itemNo: "42311" }) });
  const [match] = findLookalikes(subject, [other], MAPPING);
  assert.equal(match.matchedOn, "customerItemNo");
  assert.equal(match.confidence, 3);
});

test("blank JSON keys never match — otherwise every unmapped row pairs up", () => {
  const subject = row({ id: "a", name: "A", poNumber: "C-PO1", rawData: raw({}) });
  const other = row({ id: "b", name: "B", poNumber: "C-PO2", rawData: raw({}) });
  assert.deepEqual(findLookalikes(subject, [other], MAPPING), []);
});

test("a blank style name never matches another blank name", () => {
  const subject = row({ id: "a", name: "   ", poNumber: "C-PO1" });
  const other = row({ id: "b", name: "   ", poNumber: "C-PO2" });
  assert.deepEqual(findLookalikes(subject, [other], MAPPING), []);
});

test("name is exact — a case variant is a different style, not a lookalike", () => {
  // Deliberate: the confirmed signal is a DUPLICATED Monday row (byte-identical
  // name), and the lookup rides a plain btree index that case-folding would
  // defeat. See sameName() in related.ts.
  const subject = row({ id: "a", name: "IL62778I Fleece pants", poNumber: "C-PO1" });
  const other = row({ id: "b", name: "il62778i fleece pants", poNumber: "C-PO2" });
  assert.deepEqual(findLookalikes(subject, [other], MAPPING), []);
});

test("the strongest key wins when several would match the same row", () => {
  const subject = row({ id: "a", poNumber: "C-PO1", rawData: raw({ consignment: "ILC01989" }) });
  const other = row({ id: "b", poNumber: "C-PO2", rawData: raw({ consignment: "ILC01989" }) });
  const [match] = findLookalikes(subject, [other], MAPPING);
  assert.equal(match.matchedOn, "name");
});

test("results rank strongest-first, then by PO", () => {
  const subject = row({
    id: "a",
    name: "Fleece pants",
    poNumber: "C-PO63000",
    rawData: raw({ consignment: "ILC01989", itemNo: "42311" }),
  });
  const candidates = [
    row({ id: "weak", name: "Other", poNumber: "C-PO63100", rawData: raw({ itemNo: "42311" }) }),
    row({ id: "name-late", name: "Fleece pants", poNumber: "C-PO63394" }),
    row({ id: "mid", name: "Other", poNumber: "C-PO63200", rawData: raw({ consignment: "ILC01989" }) }),
    row({ id: "name-early", name: "Fleece pants", poNumber: "C-PO63018" }),
  ];

  assert.deepEqual(
    findLookalikes(subject, candidates, MAPPING).map((m) => m.id),
    ["name-early", "name-late", "mid", "weak"],
  );
});

test("confidence ranking is 1-based and ordered strongest-first", () => {
  assert.equal(lookalikeConfidence("name"), 1);
  assert.equal(lookalikeConfidence("consignmentCode"), 2);
  assert.equal(lookalikeConfidence("customerItemNo"), 3);
});

test("a style with no twins produces nothing at all", () => {
  const subject = row({ id: "a", name: "Unique", poNumber: "C-PO1" });
  const noise = [
    row({ id: "b", name: "Something else", poNumber: "C-PO2", rawData: raw({ itemNo: "1" }) }),
    row({ id: "c", name: "Third", poNumber: "C-PO3", rawData: raw({ consignment: "X" }) }),
  ];
  assert.deepEqual(findLookalikes(subject, noise, MAPPING), []);
});

// ── buildLookalikeChips: the bulk (list) counter ───────────────────────────

function chipRow(id: string, name: string, poNumber: string | null): LookalikeChipRow {
  return { id, name, poNumber };
}

test("chips report position and total, ordered by PO", () => {
  const a = chipRow("a", "Fleece pants", "C-PO63394");
  const b = chipRow("b", "Fleece pants", "C-PO63018");
  const chips = buildLookalikeChips([a, b], [a, b]);

  assert.deepEqual(chips.get("b"), { position: 1, total: 2, otherPoNumbers: ["C-PO63394"] });
  assert.deepEqual(chips.get("a"), { position: 2, total: 2, otherPoNumbers: ["C-PO63018"] });
});

test("a style with no name-twin gets no chip — the list stays quiet", () => {
  const a = chipRow("a", "Unique", "C-PO1");
  const b = chipRow("b", "Also unique", "C-PO2");
  const chips = buildLookalikeChips([a, b], [a, b]);
  assert.equal(chips.size, 0);
});

test("same name on the same PO gets no chip", () => {
  const a = chipRow("a", "Fleece pants", "C-PO63018");
  const b = chipRow("b", "Fleece pants", "C-PO63018");
  assert.equal(buildLookalikeChips([a, b], [a, b]).size, 0);
});

test("three-way group counts everyone and lists the other POs", () => {
  const rows = [
    chipRow("a", "Fleece pants", "C-PO63394"),
    chipRow("b", "Fleece pants", "C-PO63018"),
    chipRow("c", "Fleece pants", "C-PO63200"),
  ];
  const chips = buildLookalikeChips(rows, rows);
  assert.deepEqual(chips.get("b"), {
    position: 1,
    total: 3,
    otherPoNumbers: ["C-PO63200", "C-PO63394"],
  });
  assert.equal(chips.get("c")?.position, 2);
  assert.equal(chips.get("a")?.position, 3);
});

test("a twin missing from the page's row set still counts (query is global)", () => {
  // The list only loads the ACTIVE styles; the twin may sit in a hidden group.
  // The chip query is not filtered that way, so the hidden twin still shows up
  // in `rows` and must still warn — that's the whole point.
  const visible = chipRow("a", "Fleece pants", "C-PO63394");
  const hidden = chipRow("b", "Fleece pants", "C-PO63018");
  const chips = buildLookalikeChips([visible], [visible, hidden]);
  assert.deepEqual(chips.get("a"), { position: 2, total: 2, otherPoNumbers: ["C-PO63018"] });
});

test("a subject absent from its own group (archived) is folded back in", () => {
  const subject = chipRow("a", "Fleece pants", "C-PO63394");
  const other = chipRow("b", "Fleece pants", "C-PO63018");
  const chips = buildLookalikeChips([subject], [other]);
  assert.deepEqual(chips.get("a"), { position: 2, total: 2, otherPoNumbers: ["C-PO63018"] });
});

test("a null PO twin is labelled rather than dropped, so the count adds up", () => {
  const a = chipRow("a", "Fleece pants", "C-PO63018");
  const b = chipRow("b", "Fleece pants", null);
  const chips = buildLookalikeChips([a, b], [a, b]);
  assert.deepEqual(chips.get("a"), { position: 2, total: 2, otherPoNumbers: ["no PO"] });
  assert.equal(chips.get("b")?.otherPoNumbers.length, chips.get("b")!.total - 1);
});

test("blank names never group together", () => {
  const a = chipRow("a", "  ", "C-PO1");
  const b = chipRow("b", "  ", "C-PO2");
  assert.equal(buildLookalikeChips([a, b], [a, b]).size, 0);
});
