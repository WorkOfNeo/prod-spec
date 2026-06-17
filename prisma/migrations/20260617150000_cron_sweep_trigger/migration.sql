-- Add CRON_SWEEP to the TriggerSource enum. Tags generation jobs enqueued by
-- the periodic backlog sweep (/api/jobs/run?sweep=1) — distinct from
-- EAN_RESOLVED (barcode handoff) and WEBHOOK so dashboards/email-suppression
-- can treat cron-origin generation as its own thing.
--
-- Additive + idempotent (ADD VALUE IF NOT EXISTS, Postgres 12+); separate
-- migration so it applies cleanly regardless of what else has deployed.
ALTER TYPE "TriggerSource" ADD VALUE IF NOT EXISTS 'CRON_SWEEP';
