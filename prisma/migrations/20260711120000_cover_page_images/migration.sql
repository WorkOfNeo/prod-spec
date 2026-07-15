-- Images referenced by the GLOBAL cover-page content block (AppSetting
-- "coverPageInfoMd"). Global counterpart of prod_spec_images — the block is
-- app-wide, not owned by any one prod spec — so the bytes live in their own
-- table with no owner FK. Referenced from the markdown by a short serve URL and
-- inlined to a data URL at PDF render time. Purely additive (new table),
-- idempotent, safe to re-run via `prisma migrate deploy`.
CREATE TABLE IF NOT EXISTS "cover_page_images" (
  "id"        TEXT NOT NULL,
  "data"      BYTEA NOT NULL,
  "mimeType"  TEXT NOT NULL,
  "fileName"  TEXT NOT NULL,
  "byteSize"  INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cover_page_images_pkey" PRIMARY KEY ("id")
);
