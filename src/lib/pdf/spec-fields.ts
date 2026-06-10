import type { FieldKey, FieldSpec, PrintSpec, ValueRule } from "@/print-specs/shared/types";
import type { ColumnMapping } from "@/lib/customers/config";
import type { StyleData } from "./types";

// =====================================================
// Spec field plumbing — the bridge between the print-spec variable
// vocabulary (FieldKey) and the rest of the system:
//
//   • COLUMN_BY_FIELD    — which mapped Monday column feeds each variable
//   • styleFieldValue    — read a variable's scalar value off StyleData
//   • resolveFieldValue  — evaluate a declarative ValueRule (const/field/switch)
//   • ruleRequiredColumns— readiness for a rule: only the TAKEN branch's
//                          columns are required
//   • findFieldRule      — locate a spec field's rule by key
//
// Render and readiness must agree on rule semantics, so both live here.
// =====================================================

// Which mapped Monday column feeds each spec field. `null` = the field
// needs no column (static brand content, or derived data — care
// instructions compose from wash symbols + the DB care-label lines).
export const COLUMN_BY_FIELD: Record<FieldKey, keyof ColumnMapping | null> = {
  composition: "composition",
  composition2: "composition2",
  careInstructions: "washCare",
  washCareSymbols: "washCare",
  countryOfOrigin: "countryOfOrigin",
  sizes: "sizes",
  sizeRange: "sizes",
  ean13: "ean13",
  ean128: "cartonEan",
  customerItemNo: "customerItemNo",
  customerOrderNumber: "customerOrderNo",
  poNumber: "poNumber",
  styleNumber: "styleNumber",
  description: "description",
  qtyPerCarton: "cartonQty",
  retailPrice: "price",
  campaignWeek: "campaignWeek",
  lotNo: "lot",
  batchNo: "batchNo",
  // The customer's article number under a different label (Rema layouts).
  articleNo: "customerItemNo",
  prodNumber: "prodNumber",
  supplierAddress: null,
  oekoTexLogo: null,
  // Filled from the Customer record by the runner (StyleData.customerName),
  // not from a mapped board column.
  customerName: null,
  // Pre-Order "🌍 Shipping Terms" status column (FOB/DDP/DDU/DAP) — drives
  // the carton-marking order-number switch.
  deliveryTerm: "deliveryTerm",
};

// Scalar value of a variable on StyleData — the read side of ValueRule
// evaluation. Structured / derived variables (composition, sizes, EANs per
// size, care instructions, symbols, price) are NOT rule-usable and return ""
// — rules are for the simple string fields; rich content keeps its dedicated
// rendering path.
export function styleFieldValue(key: FieldKey, style: StyleData): string {
  switch (key) {
    case "customerName":
      return style.customerName ?? "";
    case "customerOrderNumber":
      return style.customerOrderNo ?? "";
    case "poNumber":
      return style.poNumber ?? "";
    case "deliveryTerm":
      return style.deliveryTerm ?? "";
    case "styleNumber":
      return style.styleNumber ?? "";
    case "description":
      return style.description ?? "";
    case "customerItemNo":
    case "articleNo":
      return style.customerItemNo ?? "";
    case "campaignWeek":
      return style.campaignWeek ?? "";
    case "batchNo":
      return style.batchNo ?? "";
    case "prodNumber":
      return style.prodNumber ?? "";
    case "countryOfOrigin":
      return style.countryOfOrigin ?? "";
    case "qtyPerCarton":
      return style.carton.outerVE > 0 ? String(style.carton.outerVE) : "";
    case "lotNo":
      return style.carton.lot ?? "";
    case "ean128":
      return style.carton.ean13 && style.carton.ean13 !== "0000000000000"
        ? style.carton.ean13
        : "";
    default:
      return "";
  }
}

// Case-insensitive "contains" — so a "FOB" case matches "FOB Shanghai" and
// "fob". Insertion order of `cases` decides ties (first match wins).
function matchCase(value: string, cases: Record<string, ValueRule>): ValueRule | null {
  const haystack = value.toUpperCase();
  if (!haystack.trim()) return null;
  for (const [needle, rule] of Object.entries(cases)) {
    if (needle.trim() && haystack.includes(needle.trim().toUpperCase())) return rule;
  }
  return null;
}

// Evaluate a ValueRule against StyleData (render time). Never throws; an
// unresolvable branch yields "" so the template renders its own honest gap.
export function resolveFieldValue(rule: ValueRule, style: StyleData): string {
  if ("const" in rule) return rule.const;
  if ("field" in rule) return styleFieldValue(rule.field, style);
  const matched = matchCase(styleFieldValue(rule.switch, style), rule.cases);
  const branch = matched ?? rule.default;
  return branch ? resolveFieldValue(branch, style) : "";
}

// Readiness for a rule field: which mapped columns must be non-empty given
// the CURRENT row values. Only the taken branch counts — a DDP row needs
// poNumber, not customerOrderNo — and the switch column itself is never
// required (empty ⇒ the default branch is a valid state).
export function ruleRequiredColumns(
  rule: ValueRule,
  resolve: (field: keyof ColumnMapping) => string,
): Array<keyof ColumnMapping> {
  if ("const" in rule) return [];
  if ("field" in rule) {
    const col = COLUMN_BY_FIELD[rule.field];
    return col ? [col] : [];
  }
  const switchCol = COLUMN_BY_FIELD[rule.switch];
  const value = switchCol ? resolve(switchCol) : "";
  const matched = matchCase(value, rule.cases);
  const branch = matched ?? rule.default;
  return branch ? ruleRequiredColumns(branch, resolve) : [];
}

// Locate a field's declarative rule on a spec (first part wins; specs that
// repeat a key across parts share one binding by convention).
export function findFieldRule(
  spec: Pick<PrintSpec, "parts"> | null | undefined,
  key: FieldKey,
): ValueRule | null {
  for (const part of spec?.parts ?? []) {
    for (const field of part.fields) {
      if (field.key === key && field.value) return field.value;
    }
  }
  return null;
}

// All rule-bearing fields of a spec — used to build a variant's dynamic
// readiness alongside its static required fields.
export function ruleFields(spec: Pick<PrintSpec, "parts">): FieldSpec[] {
  const out: FieldSpec[] = [];
  for (const part of spec.parts ?? []) {
    for (const field of part.fields) {
      if (field.value) out.push(field);
    }
  }
  return out;
}
