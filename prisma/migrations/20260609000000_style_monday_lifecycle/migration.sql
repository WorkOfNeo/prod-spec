-- Soft lifecycle for Monday items: archive / delete are flagged, never hard-deleted.
-- Written idempotently (IF EXISTS / IF NOT EXISTS) so it applies cleanly to the
-- already-live production database via `prisma migrate deploy` without touching data.

ALTER TABLE IF EXISTS "styles" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE IF EXISTS "styles" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "styles_archivedAt_idx" ON "styles" ("archivedAt");
CREATE INDEX IF NOT EXISTS "styles_deletedAt_idx" ON "styles" ("deletedAt");
