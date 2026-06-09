import { z } from "zod";
import { db } from "@/lib/db";
import { ColumnMappingSchema, RequiredFieldSchema, type ColumnMapping, type RequiredField } from "@/lib/customers/config";

// =====================================================
// Global Monday column config — single source of truth.
// The same columns are synced for ALL customers, so the
// column mapping + required fields live in one DB row
// (singleton id "global") instead of per customer.
// =====================================================

export const GLOBAL_COLUMN_CONFIG_ID = "global";

export const GlobalColumnConfigSchema = z.object({
  columnMapping: ColumnMappingSchema.default({}),
  requiredFields: z.array(RequiredFieldSchema).default([]),
});
export type GlobalColumnConfig = z.infer<typeof GlobalColumnConfigSchema>;

// Seed defaults — friendly placeholder ids. Replace with the real Monday
// column ids in Settings → Monday → Shared column mapping.
export const DEFAULT_COLUMN_CONFIG: GlobalColumnConfig = {
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
};

export function parseGlobalColumnConfig(raw: unknown): GlobalColumnConfig {
  return GlobalColumnConfigSchema.parse(raw ?? {});
}

export function tryParseGlobalColumnConfig(
  raw: unknown,
): { ok: true; data: GlobalColumnConfig } | { ok: false; error: z.ZodError } {
  const result = GlobalColumnConfigSchema.safeParse(raw ?? {});
  return result.success ? { ok: true, data: result.data } : { ok: false, error: result.error };
}

// Read the shared column config, seeding the singleton with defaults on first
// access. Never writes on subsequent reads (so updatedAt stays meaningful).
export async function getColumnConfig(): Promise<GlobalColumnConfig & { updatedAt: Date }> {
  let row = await db.mondayColumnConfig.findUnique({ where: { id: GLOBAL_COLUMN_CONFIG_ID } });
  if (!row) {
    row = await db.mondayColumnConfig.create({
      data: {
        id: GLOBAL_COLUMN_CONFIG_ID,
        columnMapping: DEFAULT_COLUMN_CONFIG.columnMapping as unknown as object,
        requiredFields: DEFAULT_COLUMN_CONFIG.requiredFields as unknown as object,
      },
    });
  }
  const parsed = parseGlobalColumnConfig({ columnMapping: row.columnMapping, requiredFields: row.requiredFields });
  return { ...parsed, updatedAt: row.updatedAt };
}

export async function setColumnConfig(input: {
  columnMapping: ColumnMapping;
  requiredFields: RequiredField[];
}): Promise<GlobalColumnConfig & { updatedAt: Date }> {
  const data = {
    columnMapping: input.columnMapping as unknown as object,
    requiredFields: input.requiredFields as unknown as object,
  };
  const row = await db.mondayColumnConfig.upsert({
    where: { id: GLOBAL_COLUMN_CONFIG_ID },
    create: { id: GLOBAL_COLUMN_CONFIG_ID, ...data },
    update: data,
  });
  const parsed = parseGlobalColumnConfig({ columnMapping: row.columnMapping, requiredFields: row.requiredFields });
  return { ...parsed, updatedAt: row.updatedAt };
}
