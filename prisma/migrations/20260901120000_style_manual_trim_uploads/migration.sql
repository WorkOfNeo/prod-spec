-- Manually-supplied trim documents: the file behind a "manual" row of the
-- cover's required-packaging manifest. One row per (style, normalised trim
-- label) — re-uploading replaces it, which is what "replace" means to the
-- person doing it. Bytes live here (same pattern as job_assets.pdf) so the app
-- never believes a file exists that only SharePoint has.
--
-- Additive + idempotent, safe to re-run via `prisma migrate deploy`.
CREATE TABLE IF NOT EXISTS "style_manual_trim_uploads" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "trimLabel" TEXT NOT NULL,
    "normalizedLabel" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "file" BYTEA NOT NULL,
    "sharepointDriveId" TEXT,
    "sharepointItemId" TEXT,
    "sharepointWebUrl" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "uploadError" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "style_manual_trim_uploads_pkey" PRIMARY KEY ("id")
);

-- One document per manifest line: the lookup key and the constraint are the
-- same thing, so a second upload for the same line updates rather than doubles.
CREATE UNIQUE INDEX IF NOT EXISTS "style_manual_trim_uploads_styleId_normalizedLabel_key"
    ON "style_manual_trim_uploads"("styleId", "normalizedLabel");

CREATE INDEX IF NOT EXISTS "style_manual_trim_uploads_styleId_idx"
    ON "style_manual_trim_uploads"("styleId");

DO $$
BEGIN
    ALTER TABLE "style_manual_trim_uploads"
        ADD CONSTRAINT "style_manual_trim_uploads_styleId_fkey"
        FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
