-- Review end timestamp — pairs with reviewClaimedAt (the start) to give a
-- review's start→end span for super-admin reporting (/settings/review-activity).
-- The WRITE lands at the settle seam in the approval track (maybeSettleJob /
-- publishApprovedJob); this migration only adds the column so reports can read
-- it. Additive and idempotent; existing behaviour unaffected until a value is
-- written.

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "reviewEndedAt" TIMESTAMP(3);
