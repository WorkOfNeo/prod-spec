-- A manifest line can now be answered WITHOUT this app holding the file: the
-- operator uploaded the document to the supplier's SharePoint folder by hand
-- and says so. Two consequences for the table:
--
--   1. The file columns become nullable — a hand-approved row has no bytes,
--      and inventing an empty file would be a lie the GET-bytes route serves.
--   2. Two new columns record who said it, and when.
--
-- Additive + idempotent, safe to re-run via `prisma migrate deploy`. DROP NOT
-- NULL on a column that is already nullable is a no-op, so no guard is needed.
ALTER TABLE "style_manual_trim_uploads" ALTER COLUMN "originalName" DROP NOT NULL;
ALTER TABLE "style_manual_trim_uploads" ALTER COLUMN "fileName" DROP NOT NULL;
ALTER TABLE "style_manual_trim_uploads" ALTER COLUMN "mimeType" DROP NOT NULL;
ALTER TABLE "style_manual_trim_uploads" ALTER COLUMN "byteSize" DROP NOT NULL;
ALTER TABLE "style_manual_trim_uploads" ALTER COLUMN "file" DROP NOT NULL;

ALTER TABLE "style_manual_trim_uploads"
    ADD COLUMN IF NOT EXISTS "manualApprovedAt" TIMESTAMP(3);
ALTER TABLE "style_manual_trim_uploads"
    ADD COLUMN IF NOT EXISTS "manualApprovedById" TEXT;
