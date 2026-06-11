-- Review claim — test-phase machinery (REVIEW_FOLLOW_THROUGH_DISABLED).
-- Who pressed "Start review" (or decided first) on a job awaiting review;
-- drives the leave guard + My tasks attribution. Additive and idempotent;
-- existing behaviour unaffected until a claim is written.

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "reviewClaimedById" TEXT;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "reviewClaimedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "jobs_reviewClaimedById_idx" ON "jobs"("reviewClaimedById");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "jobs"
        ADD CONSTRAINT "jobs_reviewClaimedById_fkey"
        FOREIGN KEY ("reviewClaimedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
