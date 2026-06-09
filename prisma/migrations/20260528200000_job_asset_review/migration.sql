-- CreateEnum
CREATE TYPE "AssetReviewStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "job_assets" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "rejectReason" TEXT,
ADD COLUMN     "reviewStatus" "AssetReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- CreateIndex
CREATE INDEX "job_assets_reviewStatus_docType_idx" ON "job_assets"("reviewStatus", "docType");

-- AddForeignKey
ALTER TABLE "job_assets" ADD CONSTRAINT "job_assets_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: existing assets inherit their parent Job's review status.
-- A Job in APPROVED state means every asset under it was reviewed and OK;
-- REJECTED likewise. AWAITING_REVIEW / RUNNING / FAILED / QUEUED all map
-- to PENDING_REVIEW (the column default).
UPDATE "job_assets"
SET "reviewStatus" = 'APPROVED'
WHERE "jobId" IN (SELECT id FROM "jobs" WHERE status = 'APPROVED');

UPDATE "job_assets"
SET "reviewStatus" = 'REJECTED'
WHERE "jobId" IN (SELECT id FROM "jobs" WHERE status = 'REJECTED');
