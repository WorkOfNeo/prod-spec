-- Recent-window automation: a stable "PO queued at" stamp so auto-scrape /
-- auto-generate only touch styles whose PO landed recently, parking the
-- historical backlog. Additive column + index + a one-time backfill.
--
-- Backfill = createdAt (≈ when the style + its PO entered the system) so the
-- window applies to existing rows too: recently-created PO'd styles stay in
-- window, the old thousands fall out. Idempotent (WHERE eanQueuedAt IS NULL),
-- safe to re-run via `prisma migrate deploy`.
ALTER TABLE "styles" ADD COLUMN IF NOT EXISTS "eanQueuedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "styles_eanStatus_eanQueuedAt_idx" ON "styles"("eanStatus", "eanQueuedAt");

UPDATE "styles"
SET "eanQueuedAt" = "createdAt"
WHERE "poNumber" IS NOT NULL AND "eanQueuedAt" IS NULL;
