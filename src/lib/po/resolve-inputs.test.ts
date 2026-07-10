import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCustomerConfig } from "@/lib/customers/config";
import { eanResolveInputs, eanResolveKey, readCol, splitSizes } from "./resolve-inputs";

// Default column mapping — every field falls back to its default Monday id
// (sizes__1, dropdown__1, text91__1, __name__ …) inside eanResolveInputs.
const mapping = parseCustomerConfig(null).columnMapping;

// Minimal Monday snapshot: { columnId: text }.
function raw(cols: Record<string, string>): unknown {
  return {
    column_values: Object.entries(cols).map(([id, text]) => ({ id, text, value: null })),
  };
}

test("splitSizes — splits on comma/semicolon, keeps slashes intact", () => {
  assert.deepEqual(splitSizes("S, M ; L"), ["S", "M", "L"]);
  assert.deepEqual(splitSizes("S/M, L/XL"), ["S/M", "L/XL"]);
  assert.deepEqual(splitSizes("  "), []);
});

test("readCol — trims, falls back to display_value and po.-prefixed ids", () => {
  const data = {
    column_values: [
      { id: "sizes__1", text: "  ", display_value: "One Size" },
      { id: "po.text91__1", text: "ART-9" },
    ],
  };
  assert.equal(readCol(data, "sizes__1"), "One Size");
  assert.equal(readCol(data, "text91__1"), "ART-9");
  assert.equal(readCol(data, "missing"), "");
});

test("eanResolveKey — a size-label edit changes the fingerprint (the MG90047 case)", () => {
  const before = eanResolveInputs(raw({ sizes__1: "54 - One Size" }), mapping, "MG90047", "C-PO500");
  const after = eanResolveInputs(raw({ sizes__1: "One Size" }), mapping, "MG90047", "C-PO500");
  assert.notEqual(eanResolveKey(before), eanResolveKey(after));
});

test("eanResolveKey — a colour-code edit changes the fingerprint", () => {
  const a = eanResolveInputs(raw({ sizes__1: "M", dropdown__1: "*A" }), mapping, "S1", "C-PO1");
  const b = eanResolveInputs(raw({ sizes__1: "M", dropdown__1: "*B" }), mapping, "S1", "C-PO1");
  assert.notEqual(eanResolveKey(a), eanResolveKey(b));
});

test("eanResolveKey — an unrelated column edit does NOT change the fingerprint", () => {
  const a = eanResolveInputs(raw({ sizes__1: "M", numbers3__1: "179" }), mapping, "S1", "C-PO1");
  const b = eanResolveInputs(raw({ sizes__1: "M", numbers3__1: "199" }), mapping, "S1", "C-PO1");
  assert.equal(eanResolveKey(a), eanResolveKey(b));
});

test("eanResolveInputs — styleNumber falls back to the style name", () => {
  const inp = eanResolveInputs(raw({ sizes__1: "M" }), mapping, "PTQ60031", "C-PO1");
  assert.equal(inp.styleNumber, "PTQ60031");
});

test("eanResolveKey — a bare size reorder is a real change (positions matter)", () => {
  const a = eanResolveInputs(raw({ sizes__1: "S, M" }), mapping, "S1", "C-PO1");
  const b = eanResolveInputs(raw({ sizes__1: "M, S" }), mapping, "S1", "C-PO1");
  assert.notEqual(eanResolveKey(a), eanResolveKey(b));
});

// Invariant guard: the runner recomputes the key from live Monday data via
// eanResolveInputs, while ean-runner STORES it rebuilt from the resolve
// diagnostics (empty strings collapsed to null there, restored with `?? ""`).
// The two must agree for identical inputs or every render would see a false
// "stale" and needlessly re-resolve. This mirrors that round-trip.
test("eanResolveKey — diagnostics round-trip matches the direct fingerprint", () => {
  const data = raw({ sizes__1: "M, L", text91__1: "ART-9", __name__: "S1" }); // no colour code
  const direct = eanResolveKey(eanResolveInputs(data, mapping, "S1", "C-PO1"));

  // How ean-runner rebuilds it from EanDiagnostics: value-or-null, then `?? ""`.
  const inp = eanResolveInputs(data, mapping, "S1", "C-PO1");
  const viaDiagnostics = eanResolveKey({
    poNumber: "C-PO1",
    customerItemNo: (inp.customerItemNo || null) ?? "",
    styleNumber: (inp.styleNumber || null) ?? "",
    sizes: inp.sizes,
    colourCode: (inp.colourCode || null) ?? "",
  });
  assert.equal(direct, viaDiagnostics);
});
