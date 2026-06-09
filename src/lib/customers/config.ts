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

// Per-customer config. NOTE: column mapping + required fields used to live
// here, but the same columns are synced for ALL customers, so they moved to a
// single global row (see @/lib/monday/column-config). This schema is no longer
// `.strict()` so that legacy customer configs still carrying `columnMapping` /
// `requiredFields` keys parse cleanly — the extra keys are simply ignored.
export const CustomerConfigSchema = z.object({
  mondayBoardIds: z.array(z.string().min(1)).default([]),
  enabledDocTypes: z.array(z.enum(DOC_TYPES)).default([...DOC_TYPES]),
  sharepointPath: z.string().optional(),
});

export type CustomerConfig = z.infer<typeof CustomerConfigSchema>;

export function parseCustomerConfig(raw: unknown): CustomerConfig {
  return CustomerConfigSchema.parse(raw ?? {});
}

export function tryParseCustomerConfig(raw: unknown): { ok: true; data: CustomerConfig } | { ok: false; error: z.ZodError } {
  const result = CustomerConfigSchema.safeParse(raw ?? {});
  return result.success ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

// Default config for a new customer. Column mapping is global now, so a
// customer just needs its board ids and which doc types to generate.
export const NETTO_GERMANY_DEFAULT_CONFIG: CustomerConfig = {
  mondayBoardIds: [],
  enabledDocTypes: [...DOC_TYPES],
};
