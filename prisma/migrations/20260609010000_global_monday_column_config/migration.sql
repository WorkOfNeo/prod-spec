-- Shared (global) Monday column mapping. The same columns are synced for all
-- customers, so the mapping + required fields live in a single singleton row
-- instead of per-customer config. Written idempotently so it applies cleanly to
-- the already-live production database via `prisma migrate deploy`.

CREATE TABLE IF NOT EXISTS "monday_column_config" (
  "id"             TEXT NOT NULL DEFAULT 'global',
  "columnMapping"  JSONB NOT NULL DEFAULT '{}',
  "requiredFields" JSONB NOT NULL DEFAULT '[]',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "monday_column_config_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton with the default mapping (friendly placeholder ids).
-- Replace with real Monday column ids via Settings → Monday → Shared column mapping.
INSERT INTO "monday_column_config" ("id", "columnMapping", "requiredFields")
VALUES (
  'global',
  '{"styleNumber":"style_number","businessArea":"business_area","composition":"composition","productNameTranslations":"product_name_translations","washCare":"wash_care","sizes":"sizes","ean13":"ean13","klNumber":"kl_no","supplierNumber":"supplier_number","lot":"lot","cartonQty":"carton_qty","cartonEan":"carton_ean","colourName":"colour_name","colourCode":"colour_code","price":"price","supplierEmail":"supplier_email"}',
  '[{"id":"business_area","label":"Business area"},{"id":"supplier_number","label":"Supplier"},{"id":"supplier_email","label":"Supplier email"},{"id":"composition","label":"Composition"},{"id":"wash_care","label":"Wash care"},{"id":"sizes","label":"Sizes"},{"id":"carton_qty","label":"Carton quantity (outer VE)"},{"id":"kl_no","label":"KL Number"},{"id":"lot","label":"Lot"}]'
)
ON CONFLICT ("id") DO NOTHING;
