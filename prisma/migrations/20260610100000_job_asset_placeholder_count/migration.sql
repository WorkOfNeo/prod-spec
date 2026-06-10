-- Additive, idempotent: per-asset count of placeholder artifacts (dashed
-- missing-artwork tiles, "No carton EAN configured" boxes) detected in the
-- rendered HTML. > 0 blocks approval — review-safe, never print-safe.
ALTER TABLE "job_assets" ADD COLUMN IF NOT EXISTS "placeholderCount" INTEGER NOT NULL DEFAULT 0;
