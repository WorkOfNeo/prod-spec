-- Style Dashboard throughput counts JobAsset rows by createdAt over the
-- 1h/24h/7d windows; without this index the COUNT is a sequential scan.
-- Idempotent so re-running the deploy is safe.
CREATE INDEX IF NOT EXISTS "job_assets_createdAt_idx" ON "job_assets"("createdAt");
