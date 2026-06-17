-- Add MANUAL_BULK to the TriggerSource enum. Tags generation jobs enqueued by
-- the admin "Run all outputs" bulk action on /styles (one job per style in the
-- operator's current filtered table view, grouped by a BulkRunBatch). Distinct
-- from MANUAL_RERUN so the runner can email-suppress bulk runs (a 200-style run
-- mustn't blast 200 review emails) the way CRON_SWEEP/EAN_RESOLVED already are.
--
-- Additive + idempotent (ADD VALUE IF NOT EXISTS, Postgres 12+); kept in its
-- own migration so it commits before any migration/code that USES the value
-- (Postgres can't use a new enum value in the same transaction that adds it).
ALTER TYPE "TriggerSource" ADD VALUE IF NOT EXISTS 'MANUAL_BULK';
