import {
  MANUAL_COLUMN_IDS,
  parseCustomerConfig,
  type ColumnMapping,
} from "@/lib/customers/config";
import type { MondayItem } from "@/lib/monday/client";

// Resolve one mapped field from a style's rawData, mirroring the edit
// form's readField: read by the customer's mapped column id first, then
// fall back to the manual.* id so pure-manual entries still populate.
// Empty strings count as "no value" and trigger the fallback. Keeping
// this in one place means the Details tab and the editor always agree on
// what each field resolves to.
export function resolveMappedField(
  item: MondayItem | null,
  mapping: Partial<Record<keyof ColumnMapping, string>>,
  field: keyof ColumnMapping,
): string {
  const readCol = (id: string) => {
    const c = item?.column_values?.find((x) => x.id === id);
    // Mirror / board-relation columns carry their value in display_value, not
    // text (see MondayColumnValue) — fall through to it when text is empty.
    return (c?.text ?? "").trim() || (c?.display_value ?? "").trim();
  };
  const mapped = mapping[field];
  if (mapped) {
    const v = readCol(mapped);
    if (v) return v;
  }
  return readCol(MANUAL_COLUMN_IDS[field]);
}

// Fields that have a first-class column / relation on the Style to fall back
// to when the customer's MAPPED column for that field is empty. The label is
// the human source shown in the UI when the fallback is in use.
//   poNumber        → Style.poNumber (the dedicated PO column / header value)
//   countryOfOrigin → the linked Supplier's country
//   ean13/cartonEan → the PO-PDF barcodes resolved by the EAN runner
//                     (style_eans rows + Style.cartonEan, see /po-eans)
export const FALLBACK_SOURCE = {
  poNumber: "PO field",
  countryOfOrigin: "supplier",
  ean13: "resolved PO barcodes",
  cartonEan: "resolved PO barcodes",
} as const satisfies Partial<Record<keyof ColumnMapping, string>>;

// Resolved per-size EANs → the "size=ean,size=ean" map string the PDF
// mapper's parseSizes/parseEanMap already understand (keys matched to the
// sizes column case-insensitively). Rows without an EAN are skipped;
// returns "" when nothing usable resolved (⇒ no injection).
export function formatEanMap(
  eans: ReadonlyArray<{ size: string; ean13: string | null }> | null | undefined,
): string {
  if (!eans) return "";
  return eans
    .filter((e) => e.size.trim() && e.ean13?.trim())
    .map((e) => `${e.size.trim()}=${e.ean13!.trim()}`)
    .join(",");
}

// Build the MondayItem a style resolves against, injecting the fallback
// sources above under each field's manual.* id (the universal fallback that
// resolveMappedField / the PDF mapper already consult). Mapping-based reads
// look at the customer's MAPPED column, which for some boards isn't where the
// value landed — so without this the PO would read "missing" even though the
// header shows it, country-of-origin would ignore the supplier, and the
// EANs scraped from the PO PDF would never reach the labels. Only
// FILLS THE GAP: a populated mapped column always wins.
export function effectiveStyleItem(style: {
  rawData: unknown;
  poNumber?: string | null;
  supplier?: { country?: string | null } | null;
  // Resolved PO barcodes (style_eans, ordered by position) + carton EAN.
  eans?: ReadonlyArray<{ size: string; ean13: string | null }> | null;
  cartonEan?: string | null;
}): MondayItem | null {
  const item = style.rawData as MondayItem | null;
  if (!item) return item;
  const fallbacks: Array<[keyof ColumnMapping, string | null | undefined]> = [
    ["poNumber", style.poNumber],
    ["countryOfOrigin", style.supplier?.country],
    ["ean13", formatEanMap(style.eans)],
    ["cartonEan", style.cartonEan],
  ];
  let cols = item.column_values ?? [];
  let changed = false;
  for (const [field, raw] of fallbacks) {
    const v = (raw ?? "").trim();
    if (!v) continue;
    const manualId = MANUAL_COLUMN_IDS[field];
    const present = cols.some((c) => c.id === manualId && (c.text ?? "").trim() !== "");
    if (present) continue;
    cols = [...cols, { id: manualId, type: "text", text: v, value: null }];
    changed = true;
  }
  return changed ? { ...item, column_values: cols } : item;
}

// Display labels + order for the read-only resolved-spec view. Every
// ColumnMapping key is covered (the Record satisfies that), so adding a
// mapped field surfaces here automatically.
export const STYLE_FIELD_LABELS = {
  styleNumber: "Style number",
  composition: "Composition",
  colourName: "Colour name",
  colourCode: "Colour code",
  washCare: "Wash care",
  sizes: "Sizes",
  ean13: "EAN-13 (per size)",
  cartonEan: "Carton EAN",
  cartonQty: "Carton qty (outer VE)",
  klNumber: "KL number",
  lot: "Lot",
  supplierNumber: "Supplier number",
  supplierEmail: "Supplier email",
  price: "Price",
  productNameTranslations: "Product name (translations)",
  poNumber: "PO number",
  countryOfOrigin: "Country of origin",
  certificates: "Certificates",
  businessArea: "Business area",
  // Runsven prior-solution master fields.
  customerItemNo: "Customer article no.",
  barcodeNumber: "Barcode number",
  batchNo: "Batch no.",
  targetGroup: "Target group (buying dept)",
  composition2: "Composition 2",
  customerOrderNo: "Customer order no.",
  deliveryTerm: "Delivery term (FOB/DDP)",
  description: "Description",
  prodNumber: "Prod number",
  campaignWeek: "Campaign week",
  salesUnit: "Sales unit",
  trims: "Trims (packaging & labels)",
} as const satisfies Record<keyof ColumnMapping, string>;

const FIELD_ORDER = Object.keys(STYLE_FIELD_LABELS) as Array<keyof ColumnMapping>;

export type ResolvedSpecField = {
  field: keyof ColumnMapping;
  label: string;
  value: string;
  // Set when the value came from a fallback source (the mapped column was
  // empty) — e.g. "supplier" for country of origin. The UI notes it.
  fallback?: string;
};

// Resolve every mapped spec field for read-only display. Empties are
// kept (value === "") so the verification view can surface gaps rather
// than hide them.
export function resolveStyleSpecFields(style: {
  rawData: unknown;
  customer: { config: unknown };
  poNumber?: string | null;
  supplier?: { country?: string | null } | null;
  eans?: ReadonlyArray<{ size: string; ean13: string | null }> | null;
  cartonEan?: string | null;
}): ResolvedSpecField[] {
  const original = style.rawData as MondayItem | null;
  const item = effectiveStyleItem(style);
  const mapping = parseCustomerConfig(style.customer.config).columnMapping;
  const sources = FALLBACK_SOURCE as Partial<Record<keyof ColumnMapping, string>>;
  return FIELD_ORDER.map((field) => {
    const value = resolveMappedField(item, mapping, field);
    // Fallback is in use when the un-injected item resolved empty but the
    // effective (injected) one has a value.
    const fromMapped = resolveMappedField(original, mapping, field);
    const fallback = !fromMapped && value ? sources[field] : undefined;
    return { field, label: STYLE_FIELD_LABELS[field], value, fallback };
  });
}
