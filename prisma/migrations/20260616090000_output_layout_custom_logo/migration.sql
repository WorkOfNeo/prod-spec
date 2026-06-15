-- Per-layout custom logo for the {{logo:custom}} token. Replaces the old
-- global custom logo (AppSetting "outputBuilderCustomLogo") with a column on
-- each layout. Purely additive + idempotent — safe to re-run and to apply to
-- the live DB via `prisma migrate deploy`.

ALTER TABLE "output_layouts" ADD COLUMN IF NOT EXISTS "customLogo" TEXT;
