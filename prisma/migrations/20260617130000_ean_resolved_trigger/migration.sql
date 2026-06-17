-- Add EAN_RESOLVED to the TriggerSource enum. Marks generation jobs that were
-- auto-enqueued by the PO→EAN resolve handoff (enqueueReadyOutputsAfterResolve
-- in src/lib/po/ean-runner.ts) — i.e. a scrape landed the barcodes a style's
-- outputs were waiting on, so its now-ready outputs fired without a Monday
-- re-edit.
--
-- Additive + idempotent (ADD VALUE IF NOT EXISTS, Postgres 12+), and a
-- separate migration from the eanAttempts column so it applies cleanly even if
-- that one was already deployed. Safe to re-run via `prisma migrate deploy`.
ALTER TYPE "TriggerSource" ADD VALUE IF NOT EXISTS 'EAN_RESOLVED';
