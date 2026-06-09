-- Add itemsSkipped to SyncJob — distinguishes "needs operator action"
-- (e.g. ambiguous customer match on a Style without a populated
-- customer link) from real failures.
ALTER TABLE "sync_jobs" ADD COLUMN "itemsSkipped" INTEGER NOT NULL DEFAULT 0;
