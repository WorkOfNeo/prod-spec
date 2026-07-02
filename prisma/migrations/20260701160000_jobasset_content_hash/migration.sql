-- WS9 Phase 4: stable content hash on job_assets (cover persistence). Additive.
ALTER TABLE "job_assets" ADD COLUMN IF NOT EXISTS "contentHash" TEXT;
