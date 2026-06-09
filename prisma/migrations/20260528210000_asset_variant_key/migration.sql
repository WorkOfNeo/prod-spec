-- AlterTable
ALTER TABLE "job_assets" ADD COLUMN "variantKey" TEXT;

-- Backfill: existing assets get the matching standard variant key.
-- These match TEMPLATE_VARIANTS in src/lib/pdf/template-registry.ts.
UPDATE "job_assets" SET "variantKey" = 'washcare-standard'         WHERE "docType" = 'WASHCARE'        AND "variantKey" IS NULL;
UPDATE "job_assets" SET "variantKey" = 'care-label-standard'       WHERE "docType" = 'CARE_LABEL'      AND "variantKey" IS NULL;
UPDATE "job_assets" SET "variantKey" = 'sticker-standard'          WHERE "docType" = 'STICKER'         AND "variantKey" IS NULL;
UPDATE "job_assets" SET "variantKey" = 'hangtag-standard'          WHERE "docType" = 'HANGTAG'         AND "variantKey" IS NULL;
UPDATE "job_assets" SET "variantKey" = 'carton-marking-standard'   WHERE "docType" = 'CARTON_MARKING'  AND "variantKey" IS NULL;
UPDATE "job_assets" SET "variantKey" = 'colour-sticker-standard'   WHERE "docType" = 'COLOUR_STICKER'  AND "variantKey" IS NULL;

-- DropIndex
DROP INDEX "job_assets_jobId_docType_key";

-- CreateIndex
CREATE UNIQUE INDEX "job_assets_jobId_variantKey_key" ON "job_assets"("jobId", "variantKey");
