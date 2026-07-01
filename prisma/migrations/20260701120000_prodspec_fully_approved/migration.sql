-- WS1: per-ProdSpec "Fully approved" admin toggle. Additive, non-null default
-- false. IF NOT EXISTS keeps the deploy idempotent + re-runnable via
-- `prisma migrate deploy` against the live Railway DB.
ALTER TABLE "prod_specs" ADD COLUMN IF NOT EXISTS "fullyApproved" BOOLEAN NOT NULL DEFAULT false;
