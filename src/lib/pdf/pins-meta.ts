import type { ColumnMapping } from "@/lib/customers/config";

// =====================================================
// Pin metadata — the client-safe half of the per-output field pins.
// (The StyleData application half lives in ./pins, which pulls in the
// barcode helpers and stays server-side.)
//
// A pin says "this field is ALWAYS this string" for one output of one
// ProdSpec — set in the editor, no deploy. The vocabulary is the SIMPLE
// string fields of the column-mapping space plus `customerName` (which
// comes from the Customer record, not a column). Structured fields
// (sizes, per-size EANs, wash symbols, prices, certificates) are
// deliberately not pinnable — their parsing/derivation pipelines stay
// authoritative.
// =====================================================

export type PinnableField =
  | "customerName"
  | "styleNumber"
  | "composition"
  | "colourName"
  | "colourCode"
  | "cartonQty"
  | "cartonEan"
  | "klNumber"
  | "lot"
  | "supplierNumber"
  | "customerItemNo"
  | "batchNo"
  | "prodNumber"
  | "description"
  | "campaignWeek"
  | "customerOrderNo"
  | "deliveryTerm"
  | "poNumber"
  | "countryOfOrigin";

export const PINNABLE_FIELDS: PinnableField[] = [
  "customerName",
  "styleNumber",
  "composition",
  "colourName",
  "colourCode",
  "cartonQty",
  "cartonEan",
  "klNumber",
  "lot",
  "supplierNumber",
  "customerItemNo",
  "batchNo",
  "prodNumber",
  "description",
  "campaignWeek",
  "customerOrderNo",
  "deliveryTerm",
  "poNumber",
  "countryOfOrigin",
];

// Human labels for the pin picker. Mirrors STYLE_FIELD_LABELS wording for
// the column-mapped fields; customerName is pin-only (not a mapped column).
export const PINNABLE_FIELD_LABELS: Record<PinnableField, string> = {
  customerName: "Customer name (printed)",
  styleNumber: "Style number",
  composition: "Composition (EN)",
  colourName: "Colour name",
  colourCode: "Colour code",
  cartonQty: "Carton qty (outer VE)",
  cartonEan: "Carton EAN",
  klNumber: "KL number",
  lot: "Lot",
  supplierNumber: "Supplier number",
  customerItemNo: "Customer article no.",
  batchNo: "Batch no.",
  prodNumber: "Prod number",
  description: "Description",
  campaignWeek: "Campaign week",
  customerOrderNo: "Customer order no.",
  deliveryTerm: "Delivery term (FOB/DDP)",
  poNumber: "PO number",
  countryOfOrigin: "Country of origin",
};

export function isPinnableField(key: string): key is PinnableField {
  return (PINNABLE_FIELDS as string[]).includes(key);
}

// Sanitise an unknown fieldOverrides JSON blob into a clean pin map.
// Unknown keys and non-string / blank values are dropped.
export function parseFieldOverrides(raw: unknown): Partial<Record<PinnableField, string>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<Record<PinnableField, string>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPinnableField(k)) continue;
    if (typeof v !== "string" || !v.trim()) continue;
    out[k] = v.trim();
  }
  return out;
}

// The column-mapping keys an output's pins satisfy — readiness treats these
// as filled. `customerName` isn't a mapped column, so it never appears here.
export function pinnedColumnKeys(rawOverrides: unknown): Set<keyof ColumnMapping> {
  const pins = parseFieldOverrides(rawOverrides);
  const out = new Set<keyof ColumnMapping>();
  for (const key of Object.keys(pins) as PinnableField[]) {
    if (key === "customerName") continue;
    out.add(key);
  }
  return out;
}
