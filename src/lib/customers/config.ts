import { z } from "zod";
import type { DocType } from "@/generated/prisma/enums";

// =====================================================
// Customer.config schema — single source of truth
// for all per-customer behaviour. Editing this struct
// in the admin UI is what unblocks a new customer; no
// code changes needed.
// =====================================================

export const DOC_TYPES = [
  "WASHCARE",
  "CARE_LABEL",
  "STICKER",
  "HANGTAG",
  "CARTON_MARKING",
  "COLOUR_STICKER",
] as const satisfies readonly DocType[];

export const ColumnMappingSchema = z.object({
  styleNumber: z.string().optional(),
  businessArea: z.string().optional(),
  composition: z.string().optional(),
  productNameTranslations: z.string().optional(),
  washCare: z.string().optional(),
  sizes: z.string().optional(),
  ean13: z.string().optional(),
  klNumber: z.string().optional(),
  supplierNumber: z.string().optional(),
  lot: z.string().optional(),
  cartonQty: z.string().optional(),
  cartonEan: z.string().optional(),
  colourName: z.string().optional(),
  colourCode: z.string().optional(),
  price: z.string().optional(),
  supplierEmail: z.string().optional(),
  // Fields lifted from the prior Excel solution's "Sheet1" master. Most
  // live on the Pre-Order board (mapped with the "po." enrichment prefix).
  // They flow into Style.rawData and surface on the Details tab; printable
  // outputs consume them as those templates get built.
  customerItemNo: z.string().optional(), // Customer Article number → 🔑 Customer Item No
  barcodeNumber: z.string().optional(), // Barcode number → Barcode Number
  batchNo: z.string().optional(), // Batch nr → Batch nr
  targetGroup: z.string().optional(), // Buying Dept → 🎯 Target Group
  composition2: z.string().optional(), // Composition 2 → 2nd Composition
  customerOrderNo: z.string().optional(), // customer order number → 🔢 Customer Order Number
  // Delivery term for the order, expected "FOB" or "DDP". Drives which
  // order number the Netto carton marking prints (FOB → customerOrderNo,
  // DDP → poNumber). No DEFAULT_COLUMN_MAPPING entry yet — point this at
  // the Pre-Order board's FOB/DDP column in /settings/customers/<id>.
  deliveryTerm: z.string().optional(),
  description: z.string().optional(), // Description → Description
  prodNumber: z.string().optional(), // Prod number → Prod number
  campaignWeek: z.string().optional(), // Product category / campaign week → 📅 Campaign Week
  salesUnit: z.string().optional(), // Sales unit → Sales unit
  trims: z.string().optional(), // Packaging and Labels → 👜 Trims (decides packaging materials)
  // PO number rendered on the back panel of long care labels (care-
  // label-02 "Sheet 3 FRONT"). Sourced from the Styles board's
  // po_number__1 column today; can be overridden per customer.
  poNumber: z.string().optional(),
  // Country of origin — used by long care labels ("Made in X" in
  // multiple languages). Default mapping points at the Pre-Order board's
  // "🌍 Country of Origin" mirror (lifted as po.mirror__1), which proxies
  // the linked factory/supplier's country. Mirror values arrive via
  // display_value (see columnText / the Monday MirrorValue fragment).
  countryOfOrigin: z.string().optional(),
  // Certificates — comma-separated names (e.g. "FSC, OEKOTEX") matched
  // against the Certificate library for logos on care-label-02 page 4.
  // Default mapping points at the Styles board's __certificates__1 column.
  certificates: z.string().optional(),
});
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

export const RequiredFieldSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});
export type RequiredField = z.infer<typeof RequiredFieldSchema>;

// Per-customer barcode font override. Default (when omitted) is the
// `Libre Barcode 128 Text` proposal in plan §"Open items".
export const BarcodeFontSchema = z.object({
  family: z.string().min(1),
  // `src` is either a full https URL (Google Fonts, CDN, etc.) or a
  // path relative to /public served from this app.
  src: z.string().min(1),
});
export type BarcodeFont = z.infer<typeof BarcodeFontSchema>;

export const CustomerConfigSchema = z
  .object({
    mondayBoardIds: z.array(z.string().min(1)).default([]),
    columnMapping: ColumnMappingSchema.default({}),
    requiredFields: z.array(RequiredFieldSchema).default([]),
    enabledDocTypes: z.array(z.enum(DOC_TYPES)).default([...DOC_TYPES]),
    sharepointPath: z.string().optional(),
    barcodeFont: BarcodeFontSchema.optional(),
    logoUrl: z.string().optional(),
  })
  .strict();

export type CustomerConfig = z.infer<typeof CustomerConfigSchema>;

// Global default column mapping. Per-customer overrides still win — the
// merge in parseCustomerConfig puts the customer's map LAST.
//
// Styles are now sourced DIRECTLY from the Pre-Order board (7322835224),
// so every id below is a native Pre-Order column id (no "po." prefix /
// enrichment overlay any more). `__name__` is the synthetic column ingest
// injects carrying the Pre-Order row name (the Contrast IL-code).
//
// Not mapped here (no native Pre-Order source):
//   • ean13 — per-size EANs come from the PO PDF in the SharePoint folder
//     ("Barcodes" page); wired separately.
//   • productNameTranslations — no EN/DE name column on the board.
//   • supplierNumber / supplierEmail — resolved via the Supplier relation,
//     not a column.
export const DEFAULT_COLUMN_MAPPING: Partial<ColumnMapping> = {
  styleNumber: "__name__", // Pre-Order ROW NAME (IL-code), injected by ingest
  businessArea: "status_18__1", // 👔 Business Area
  composition: "text64__1", // Composition
  colourName: "text_mktbynx8", // Color Name From Client
  colourCode: "dropdown__1", // 🎨 Color Code
  certificates: "certifications__1", // 🪪 Certificates
  poNumber: "text44__1", // #️⃣ PO Number
  countryOfOrigin: "mirror__1", // 🌍 Country of Origin (mirror → display_value)
  sizes: "sizes__1", // Sizes
  washCare: "dropdown_mktbzd1f", // Wash Care Symbols
  lot: "numeric_mktagw13", // Lot No
  cartonQty: "text2__1", // Qty/Carton
  cartonEan: "numeric_mktagpmg", // Carton Barcode number
  klNumber: "text_mkv0ebfg", // KL No.
  price: "retail_prices__1", // Retail Prices
  customerItemNo: "text91__1", // 🔑 Customer Item No
  barcodeNumber: "numeric_mkta3mqk", // Barcode Number
  batchNo: "numeric_mkta7tzg", // Batch nr
  targetGroup: "status87__1", // 🎯 Target Group
  composition2: "text_mktbv53f", // 2nd Composition
  customerOrderNo: "customer_order_number__1", // 🔢 Customer Order Number
  description: "long_text_mkrvd8j3", // Description
  prodNumber: "numeric_mkta1jd5", // Prod number
  campaignWeek: "text33__1", // 📅 Campaign Week
  salesUnit: "numeric_mkta4201", // Sales unit
  trims: "dropdown4__1", // 👜 Trims
};

// Legacy alias — old import sites still reference this name. Kept as a
// re-export so we can remove it incrementally without breaking builds.
export const STYLES_BOARD_COLUMN_MAPPING = DEFAULT_COLUMN_MAPPING;

export function parseCustomerConfig(raw: unknown): CustomerConfig {
  const cfg = CustomerConfigSchema.parse(raw ?? {});
  return {
    ...cfg,
    columnMapping: {
      ...DEFAULT_COLUMN_MAPPING,
      ...cfg.columnMapping,
    },
  };
}

export function tryParseCustomerConfig(raw: unknown): { ok: true; data: CustomerConfig } | { ok: false; error: z.ZodError } {
  const result = CustomerConfigSchema.safeParse(raw ?? {});
  if (!result.success) return { ok: false, error: result.error };
  return {
    ok: true,
    data: {
      ...result.data,
      columnMapping: {
        ...STYLES_BOARD_COLUMN_MAPPING,
        ...result.data.columnMapping,
      },
    },
  };
}

// Column-id namespace used by the manual-style entry form. The form builds
// a synthetic MondayItem with column_values keyed by these ids, and the
// customer config below points each ProdSpec field at the matching id.
// When real Monday integration lands, replace these with Dilip's actual
// column ids; the form is the fallback for offline / pre-integration work.
export const MANUAL_COLUMN_IDS = {
  styleNumber: "manual.styleNumber",
  businessArea: "manual.businessArea",
  composition: "manual.composition",
  productNameTranslations: "manual.productNameTranslations",
  washCare: "manual.washCare",
  sizes: "manual.sizes",
  ean13: "manual.ean13",
  klNumber: "manual.klNumber",
  supplierNumber: "manual.supplierNumber",
  lot: "manual.lot",
  cartonQty: "manual.cartonQty",
  cartonEan: "manual.cartonEan",
  colourName: "manual.colourName",
  colourCode: "manual.colourCode",
  price: "manual.price",
  supplierEmail: "manual.supplierEmail",
  customerItemNo: "manual.customerItemNo",
  barcodeNumber: "manual.barcodeNumber",
  batchNo: "manual.batchNo",
  targetGroup: "manual.targetGroup",
  composition2: "manual.composition2",
  customerOrderNo: "manual.customerOrderNo",
  deliveryTerm: "manual.deliveryTerm",
  description: "manual.description",
  prodNumber: "manual.prodNumber",
  campaignWeek: "manual.campaignWeek",
  salesUnit: "manual.salesUnit",
  trims: "manual.trims",
  poNumber: "manual.poNumber",
  countryOfOrigin: "manual.countryOfOrigin",
  certificates: "manual.certificates",
} as const satisfies Record<keyof ColumnMapping, string>;

// Default config for Netto Germany. Ships pointing at the manual.* column
// ids so the manual entry form works out of the box. When Monday goes
// live, edit these in /settings/customers/<id> to the real ids.
export const NETTO_GERMANY_DEFAULT_CONFIG: CustomerConfig = {
  mondayBoardIds: [],
  columnMapping: { ...MANUAL_COLUMN_IDS },
  requiredFields: [
    { id: MANUAL_COLUMN_IDS.businessArea, label: "Business area" },
    { id: MANUAL_COLUMN_IDS.supplierNumber, label: "Supplier" },
    { id: MANUAL_COLUMN_IDS.composition, label: "Composition" },
    { id: MANUAL_COLUMN_IDS.washCare, label: "Wash care" },
    { id: MANUAL_COLUMN_IDS.sizes, label: "Sizes" },
    { id: MANUAL_COLUMN_IDS.ean13, label: "EAN per size" },
    { id: MANUAL_COLUMN_IDS.cartonQty, label: "Carton quantity (outer VE)" },
    { id: MANUAL_COLUMN_IDS.klNumber, label: "KL Number" },
    { id: MANUAL_COLUMN_IDS.lot, label: "Lot" },
  ],
  enabledDocTypes: [...DOC_TYPES],
};
