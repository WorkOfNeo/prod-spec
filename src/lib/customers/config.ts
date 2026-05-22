import { z } from "zod";
import type { DocType } from "@/generated/prisma/enums";

// =====================================================
// Customer.config schema — single source of truth
// for all per-customer behaviour. Editing this struct
// in the admin UI is what unblocks a new customer; no
// code changes needed.
// =====================================================

export const DOC_TYPES = ["WASHCARE", "STICKER", "CARTON_MARKING", "COLOUR_STICKER"] as const satisfies readonly DocType[];

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
});
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

export const RequiredFieldSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});
export type RequiredField = z.infer<typeof RequiredFieldSchema>;

export const CustomerConfigSchema = z
  .object({
    mondayBoardIds: z.array(z.string().min(1)).default([]),
    columnMapping: ColumnMappingSchema.default({}),
    requiredFields: z.array(RequiredFieldSchema).default([]),
    enabledDocTypes: z.array(z.enum(DOC_TYPES)).default([...DOC_TYPES]),
    sharepointPath: z.string().optional(),
  })
  .strict();

export type CustomerConfig = z.infer<typeof CustomerConfigSchema>;

export function parseCustomerConfig(raw: unknown): CustomerConfig {
  return CustomerConfigSchema.parse(raw ?? {});
}

export function tryParseCustomerConfig(raw: unknown): { ok: true; data: CustomerConfig } | { ok: false; error: z.ZodError } {
  const result = CustomerConfigSchema.safeParse(raw ?? {});
  return result.success ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

// Default config for Netto Germany — placeholder column IDs match the
// names used in the early webhook scaffolding. Replace with the real IDs
// from Dilip's column-mapping doc.
export const NETTO_GERMANY_DEFAULT_CONFIG: CustomerConfig = {
  mondayBoardIds: [],
  columnMapping: {
    styleNumber: "style_number",
    businessArea: "business_area",
    composition: "composition",
    productNameTranslations: "product_name_translations",
    washCare: "wash_care",
    sizes: "sizes",
    ean13: "ean13",
    klNumber: "kl_no",
    supplierNumber: "supplier_number",
    lot: "lot",
    cartonQty: "carton_qty",
    cartonEan: "carton_ean",
    colourName: "colour_name",
    colourCode: "colour_code",
    price: "price",
    supplierEmail: "supplier_email",
  },
  requiredFields: [
    { id: "business_area", label: "Business area" },
    { id: "supplier_number", label: "Supplier" },
    { id: "supplier_email", label: "Supplier email" },
    { id: "composition", label: "Composition" },
    { id: "wash_care", label: "Wash care" },
    { id: "sizes", label: "Sizes" },
    { id: "carton_qty", label: "Carton quantity (outer VE)" },
    { id: "kl_no", label: "KL Number" },
    { id: "lot", label: "Lot" },
  ],
  enabledDocTypes: [...DOC_TYPES],
};
