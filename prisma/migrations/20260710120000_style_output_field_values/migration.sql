-- Per-(style × output × field) reviewer-supplied field values. One row per
-- (style, base variantKey, field) the reviewer filled/overrode inline on the
-- review surfaces — composed with the ProdSpec output's pins (per-style wins),
-- treated as filled by readiness/the runner and printed via applyFieldOverrides.
-- Additive, idempotent (IF NOT EXISTS) so it's safe + re-runnable via
-- `prisma migrate deploy` against the live Railway DB.
CREATE TABLE IF NOT EXISTS "style_output_field_values" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "outputName" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "style_output_field_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "style_output_field_values_styleId_variantKey_field_key"
    ON "style_output_field_values" ("styleId", "variantKey", "field");
CREATE INDEX IF NOT EXISTS "style_output_field_values_styleId_idx"
    ON "style_output_field_values" ("styleId");
