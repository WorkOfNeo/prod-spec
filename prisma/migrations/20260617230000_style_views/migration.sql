-- Style view log — append-only, one row per page open (REVIEW = the review
-- screen, STYLE = the style detail page), per user. Powers the Views tab of the
-- admin oversight panel (/admin). Purely additive (new enum + table), idempotent,
-- safe to re-run via `prisma migrate deploy`. No change to existing tables.

-- Enum for the view surface. Guarded so re-running the migration is a no-op.
DO $$ BEGIN
  CREATE TYPE "StyleViewSurface" AS ENUM ('REVIEW', 'STYLE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "style_views" (
  "id"        TEXT NOT NULL,
  "styleId"   TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "surface"   "StyleViewSurface" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "style_views_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "style_views_styleId_createdAt_idx" ON "style_views"("styleId", "createdAt");
CREATE INDEX IF NOT EXISTS "style_views_userId_createdAt_idx" ON "style_views"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "style_views_createdAt_idx" ON "style_views"("createdAt");

-- FKs with cascade — view rows vanish when their style or user is deleted.
DO $$ BEGIN
  ALTER TABLE "style_views" ADD CONSTRAINT "style_views_styleId_fkey"
    FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "style_views" ADD CONSTRAINT "style_views_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
