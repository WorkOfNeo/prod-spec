-- Per-(style × output) operator ignores. One row per (style, base variantKey)
-- the operator marked "not wanted for this style" — skipped by generation,
-- SharePoint upload and the nightly supplier email. Additive, idempotent
-- (IF NOT EXISTS) so it's safe + re-runnable via `prisma migrate deploy`
-- against the live Railway DB.
CREATE TABLE IF NOT EXISTS "style_output_ignores" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "outputName" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "style_output_ignores_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "style_output_ignores_styleId_variantKey_key"
    ON "style_output_ignores" ("styleId", "variantKey");
CREATE INDEX IF NOT EXISTS "style_output_ignores_styleId_idx"
    ON "style_output_ignores" ("styleId");
