-- Logo image library + per-style link. {{logo:custom}} stops reading the
-- global AppSetting ("outputBuilderCustomLogo") and renders the LogoImage
-- linked on each style instead — the logo is decided per style.
-- Idempotent: safe to re-run against the live DB.

CREATE TABLE IF NOT EXISTS "logo_images" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "logo_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "logo_images_active_idx" ON "logo_images"("active");

ALTER TABLE "styles" ADD COLUMN IF NOT EXISTS "logoImageId" TEXT;

CREATE INDEX IF NOT EXISTS "styles_logoImageId_idx" ON "styles"("logoImageId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'styles_logoImageId_fkey'
  ) THEN
    ALTER TABLE "styles"
      ADD CONSTRAINT "styles_logoImageId_fkey"
      FOREIGN KEY ("logoImageId") REFERENCES "logo_images"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Carry the old global Output Builder logo into the gallery so the
-- artwork isn't lost. NOT auto-linked to any style — operators link it
-- explicitly where it belongs. (AppSetting.value is a JSON string; the
-- #>> '{}' extraction unwraps it to text.)
INSERT INTO "logo_images" ("id", "name", "image", "active", "createdAt", "updatedAt")
SELECT 'logo-migrated-global', 'Custom logo (migrated from Output Builder)',
       ("value" #>> '{}'), true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "app_settings"
WHERE "key" = 'outputBuilderCustomLogo'
  AND ("value" #>> '{}') LIKE 'data:image/%'
ON CONFLICT ("id") DO NOTHING;
