-- Per-page print settings for the bundle framing pages (cover + general
-- information): margins, base font size, line height, footer toggle.
-- One JSON column, empty object = defaults. Purely additive and written
-- idempotently to match the repo convention — applies cleanly to the
-- already-live database via `prisma migrate deploy`.

ALTER TABLE "prod_specs" ADD COLUMN IF NOT EXISTS "bundlePageSettings" JSONB NOT NULL DEFAULT '{}';
