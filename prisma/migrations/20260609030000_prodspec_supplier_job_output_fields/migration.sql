-- Per-output generation + per-ProdSpec language selection + supplier contact details.
-- All additive and nullable / defaulted, so this applies cleanly to the already-live
-- production database via `prisma migrate deploy`. Written idempotently
-- (ADD COLUMN IF NOT EXISTS) to match the repo convention.

-- ProdSpec: languages this ProdSpec's outputs render (array of lowercase codes).
ALTER TABLE "prod_specs" ADD COLUMN IF NOT EXISTS "outputLanguages" JSONB NOT NULL DEFAULT '[]';

-- Supplier: contact details mirrored from the Monday suppliers board.
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "contactEmail" TEXT;
ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "contactName" TEXT;

-- Job: per-output generation scope (the variant keys this job should render).
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "variantKeys" JSONB NOT NULL DEFAULT '[]';
