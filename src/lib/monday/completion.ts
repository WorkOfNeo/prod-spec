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
