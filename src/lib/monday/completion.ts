import type { MondayItem, MondayColumnValue } from "./client";
import type { RequiredField } from "@/lib/customers/config";

export type CompletionResult = {
  completionPct: number;
  missingFields: Array<{ id: string; label: string }>;
};

function isFilled(col: MondayColumnValue | undefined): boolean {
  if (!col) return false;
  if (col.text && col.text.trim() !== "") return true;
  if (col.value && col.value !== "null" && col.value !== '""' && col.value !== "{}") return true;
  return false;
}

// Inject synthetic column values (e.g. PO-PDF-resolved EANs) into an item
// before evaluating completion. Required fields are keyed by raw column id,
// so resolved data must appear under the very ids the requirement names —
// the manual.* fallback that resolveMappedField consults is not enough
// here. Only fills gaps: a column that already has a value is left alone.
export function withSyntheticColumns(
  item: Pick<MondayItem, "column_values">,
  additions: ReadonlyArray<{ id: string; text: string }>,
): Pick<MondayItem, "column_values"> {
  let cols = item.column_values ?? [];
  let changed = false;
  for (const a of additions) {
    if (!a.id || !a.text.trim()) continue;
    if (isFilled(cols.find((c) => c.id === a.id))) continue;
    cols = [...cols.filter((c) => c.id !== a.id), { id: a.id, type: "text", text: a.text, value: null }];
    changed = true;
  }
  return changed ? { ...item, column_values: cols } : item;
}

export function evaluateCompletion(
  item: Pick<MondayItem, "column_values">,
  required: ReadonlyArray<RequiredField>,
): CompletionResult {
  if (required.length === 0) return { completionPct: 100, missingFields: [] };

  const colsById = new Map(item.column_values.map((c) => [c.id, c]));
  const missing: Array<{ id: string; label: string }> = [];

  for (const field of required) {
    if (!isFilled(colsById.get(field.id))) {
      missing.push({ id: field.id, label: field.label });
    }
  }

  const filled = required.length - missing.length;
  return { completionPct: Math.round((filled / required.length) * 100), missingFields: missing };
}
