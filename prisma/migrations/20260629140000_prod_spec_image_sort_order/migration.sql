-- Ordered image collection for the ProdSpec General information page: images
-- render stacked on the General page, lowest sortOrder first (createdAt breaks
-- ties). Additive + idempotent, safe to re-run via `prisma migrate deploy`.
ALTER TABLE "prod_spec_images" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Composite index for ordered reads; replaces the old single-column index.
CREATE INDEX IF NOT EXISTS "prod_spec_images_prodSpecId_sortOrder_idx" ON "prod_spec_images"("prodSpecId", "sortOrder");
DROP INDEX IF EXISTS "prod_spec_images_prodSpecId_idx";
