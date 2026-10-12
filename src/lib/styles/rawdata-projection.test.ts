import { test, before } from "node:test";
import assert from "node:assert/strict";
import type { ColumnMapping } from "@/lib/customers/config";

// rawdata-projection.ts imports @/lib/db, whose client construction needs
// DATABASE_URL at import time. Nothing here queries — the pg pool is lazy.
process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db?sslmode=disable";

let listPathColumnIds: typeof import("./rawdata-projection").listPathColumnIds;
let projectRawData: typeof import("./rawdata-projection").projectRawData;
let effectiveStyleItem: typeof import("./resolved-fields").effectiveStyleItem;
let resolveMappedField: typeof import("./resolved-fields").resolveMappedField;
let parseCustomerConfig: typeof import("@/lib/customers/config").parseCustomerConfig;
let MANUAL_COLUMN_IDS: typeof import("@/lib/customers/config").MANUAL_COLUMN_IDS;

before(async () => {
  ({ listPathColumnIds, projectRawData } = await import("./rawdata-projection"));
  ({ effectiveStyleItem, resolveMappedField } = await import("./resolved-fields"));
  ({ parseCustomerConfig, MANUAL_COLUMN_IDS } = await import("@/lib/customers/config"));
});

// ---------------------------------------------------------------------------
// The /styles list reads rawData only through resolveMappedField (directly or
// via the resolver every readiness walk is handed) and effectiveStyleItem.
// The projection is correct iff every such read sees the same thing on the
// projected item as on the full one — that is what these tests pin.
// ---------------------------------------------------------------------------

const cv = (id: string, text: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  type: "text",
  text,
  value: text == null ? null : JSON.stringify(text),
  ...extra,
});

// A Monday item: mapped columns, noise the list never reads, a duplicate id
// (first copy empty — find() must still return the first one), a mirror
// column carried in display_value, an id-less entry and manual.* fallbacks.
function item(extraCols: Array<Record<string, unknown>> = []) {
  return {
    id: "9001",
    name: "IL90001",
    board: { id: "7322835224" },
    group: { id: "g1", title: "Incoming" },
    column_values: [
      cv("files_noise", "https://example.test/spec.pdf", { type: "file", value: '{"files":[1,2,3]}' }),
      cv("text64__1", ""),
      cv("text64__1", "95% Cotton 5% Elastane"),
      cv("long_text_noise", "x".repeat(500)),
      { id: "mirror__1", type: "mirror", text: null, value: null, display_value: "Bangladesh" },
      cv("coop_composition", "100% Organic Cotton"),
      cv("sizes__1", "S,M,L"),
      cv("dup__of_status__1", "FOB"),
      cv("text44__1", ""),
      { text: "legacy value" },
      cv("manual.washCare", "30,Iron"),
      cv("status_noise", "Done", { value: '{"index":1}' }),
      ...extraCols,
    ],
  };
}

const MAPPINGS: Array<Partial<ColumnMapping>> = [
  {},
  { composition: "coop_composition", deliveryTerm: "coop_terms" },
  { composition: "manual.composition", sizes: "ww_sizes", washCare: "" },
];

// Every field the list can resolve, plus rule fields that are NOT ColumnMapping
// keys (an output rule's `field` is free text) — including prototype names.
function fieldsToProbe(): string[] {
  return [
    ...Object.keys(MANUAL_COLUMN_IDS),
    "legacyField",
    "toString",
    "constructor",
    "__proto__",
    "hasOwnProperty",
  ];
}

test("listPathColumnIds: manual ids + every mapped id, deduped, blanks dropped", () => {
  const ids = listPathColumnIds([
    parseCustomerConfig({}).columnMapping,
    parseCustomerConfig({ columnMapping: { composition: "coop_composition", washCare: "" } }).columnMapping,
  ]);
  for (const id of Object.values(MANUAL_COLUMN_IDS)) assert.ok(ids.includes(id), id);
  assert.ok(ids.includes("text64__1"), "default mapping is merged in");
  assert.ok(ids.includes("coop_composition"), "a customer's own column");
  assert.ok(!ids.includes(""), "an emptied mapping adds nothing");
  assert.equal(new Set(ids).size, ids.length);
});

test("projectRawData keeps the item's top-level fields and only listed columns, in order", () => {
  const full = item();
  const p = projectRawData(full, new Set(["text64__1", "mirror__1", "manual.washCare"])) as typeof full;
  assert.equal(p.id, full.id);
  assert.equal(p.name, full.name);
  assert.deepEqual(p.board, full.board);
  assert.deepEqual(p.group, full.group);
  assert.deepEqual(
    p.column_values.map((c) => ("id" in c ? c.id : "(no id)")),
    ["text64__1", "text64__1", "mirror__1", "(no id)", "manual.washCare"],
  );
  // Kept entries are whole, not trimmed.
  assert.deepEqual(p.column_values[2], full.column_values[4]);
  // The input is not mutated.
  assert.equal(full.column_values.length, 12);
});

test("projectRawData keeps entries a lookup can still land on", () => {
  const raw = {
    column_values: [null, "stray", [1], { text: "no id" }, { id: null, text: "x" }, { id: 7, text: "y" }, cv("keep", "k")],
  };
  const p = projectRawData(raw, new Set(["keep", "7"])) as { column_values: unknown[] };
  // null / scalars / arrays / id-less objects stay; non-string ids never match.
  assert.deepEqual(p.column_values, [null, "stray", [1], { text: "no id" }, cv("keep", "k")]);
});

test("projectRawData passes through anything without a column_values array", () => {
  const ids = new Set(["a"]);
  for (const raw of [null, {}, { column_values: null }, { column_values: { a: 1 } }, [], "x", 0, false]) {
    assert.equal(projectRawData(raw, ids), raw);
  }
});

test("every list-path read resolves the same on the projected item", () => {
  const fallbacks = [
    {},
    { poNumber: "C-PO62700", supplier: { country: "China" } },
    { eans: [{ size: "S", ean13: "5700000000011" }], cartonEan: "5709876543210" },
  ];
  const items: unknown[] = [item(), item([cv("manual.composition", "80% Wool")]), { column_values: [] }, {}, null];
  for (const rawMapping of MAPPINGS) {
    const mapping = parseCustomerConfig({ columnMapping: rawMapping }).columnMapping;
    const ids = new Set(listPathColumnIds([mapping]));
    for (const raw of items) {
      const projected = projectRawData(raw, ids);
      for (const fb of fallbacks) {
        const fullItem = effectiveStyleItem({ rawData: raw, ...fb });
        const projItem = effectiveStyleItem({ rawData: projected, ...fb });
        for (const f of fieldsToProbe()) {
          const field = f as keyof ColumnMapping;
          assert.equal(
            resolveMappedField(projItem, mapping, field),
            resolveMappedField(fullItem, mapping, field),
            `${JSON.stringify(rawMapping)} · ${f}`,
          );
        }
      }
    }
  }
});

test("a rule on a non-mapping field still reads the id-less entry", () => {
  const mapping = parseCustomerConfig({}).columnMapping;
  const ids = new Set(listPathColumnIds([mapping]));
  const projected = effectiveStyleItem({ rawData: projectRawData(item(), ids) });
  assert.equal(resolveMappedField(projected, mapping, "legacyField" as keyof ColumnMapping), "legacy value");
});

test("a malformed entry throws the same way on the projected item", () => {
  const mapping = parseCustomerConfig({}).columnMapping;
  const ids = new Set(listPathColumnIds([mapping]));
  // A null entry ahead of the mapped column: find() dereferences it.
  const raw = { column_values: [cv("noise", "n"), null, cv("text64__1", "Cotton")] };
  const read = (r: unknown) => () => resolveMappedField(effectiveStyleItem({ rawData: r }), mapping, "composition");
  assert.throws(read(raw), TypeError);
  assert.throws(read(projectRawData(raw, ids)), TypeError);
});
