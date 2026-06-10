import { db } from "@/lib/db";
import { parseCustomerConfig, type ColumnMapping } from "@/lib/customers/config";
import type { MondayItem } from "@/lib/monday/client";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { requiredFieldsForVariants } from "@/lib/pdf/template-registry";
import { resolveMappedField, STYLE_FIELD_LABELS, effectiveStyleItem } from "./resolved-fields";

// =====================================================
// "Required detail fields" = the resolved-spec fields a style must carry a
// value for before it can generate. The set is NOT a global list — it is the
// UNION of the fields each ENABLED output on the style's ProdSpec declares it
// needs (see template-registry `requiredFields`). Evaluated here for both the
// readiness visuals and the auto-enqueue gate so the two always agree.
// =====================================================

export type DetailFieldKey = keyof ColumnMapping;

export type MissingDetailField = { field: DetailFieldKey; label: string };

// Required field keys for a style = the union across its ProdSpec's ENABLED
// outputs. `outputs` is ProdSpec.outputs JSON (null/undefined ⇒ none).
export function requiredFieldKeysFromOutputs(outputs: unknown): DetailFieldKey[] {
  const enabled = parseProdSpecOutputs(outputs ?? [])
    .filter((o) => o.enabled !== false)
    .map((o) => o.variantKey);
  return requiredFieldsForVariants(enabled);
}

// Which required keys resolve to an empty value for this style's raw Monday
// data + mapping. Pure — caller supplies the parsed mapping (so a list view
// can parse each customer's config once instead of per row).
export function findMissingDetailFields(
  rawData: unknown,
  mapping: ColumnMapping,
  requiredKeys: ReadonlyArray<DetailFieldKey>,
): MissingDetailField[] {
  const item = rawData as MondayItem | null;
  return requiredKeys
    .filter((f) => !resolveMappedField(item, mapping, f).trim())
    .map((f) => ({ field: f, label: STYLE_FIELD_LABELS[f] }));
}

// Single-style convenience (detail page / gate): required keys come from the
// style's enabled outputs; parses the customer config itself. Returns [] when
// the outputs need nothing (or there are no outputs).
export function findMissingDetailFieldsForStyle(style: {
  rawData: unknown;
  poNumber?: string | null;
  supplier?: { country?: string | null } | null;
  eans?: ReadonlyArray<{ size: string; ean13: string | null }> | null;
  cartonEan?: string | null;
  customer: { config: unknown };
  prodSpec: { outputs: unknown } | null;
}): MissingDetailField[] {
  const keys = requiredFieldKeysFromOutputs(style.prodSpec?.outputs);
  if (keys.length === 0) return [];
  const mapping = parseCustomerConfig(style.customer.config).columnMapping;
  return findMissingDetailFields(effectiveStyleItem(style), mapping, keys);
}

// Gate helper for the auto-enqueue paths: true when every field the style's
// enabled outputs need is filled (or nothing is required). Loads the minimal
// columns it needs.
export async function hasAllRequiredDetailFields(styleId: string): Promise<boolean> {
  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      rawData: true,
      poNumber: true,
      cartonEan: true,
      supplier: { select: { country: true } },
      eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true } },
      customer: { select: { config: true } },
      prodSpec: { select: { outputs: true } },
    },
  });
  if (!style) return false;
  return findMissingDetailFieldsForStyle(style).length === 0;
}
