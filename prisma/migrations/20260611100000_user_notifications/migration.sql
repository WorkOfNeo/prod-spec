-- Per-user notifications — the /dashboard feed. Additive only; existing
-- behaviour is unaffected until a row is written. In-app mirrors of the
-- REVIEW_READY / TICKET_FIXED emails land here; the dashboard's
-- "unfinished review" rows do NOT (those are derived from Job/JobAsset).
-- Idempotent: safe to re-run against a database that already has it.

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "UserNotificationType" AS ENUM ('REVIEW_READY', 'TICKET_FIXED', 'GENERIC');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "UserNotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "jobId" TEXT,
    "styleId" TEXT,
    "ticketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_notifications_userId_dismissedAt_resolvedAt_createdAt_idx"
    ON "user_notifications"("userId", "dismissedAt", "resolvedAt", "createdAt");

CREATE INDEX IF NOT EXISTS "user_notifications_jobId_idx"
    ON "user_notifications"("jobId");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "user_notifications"
        ADD CONSTRAINT "user_notifications_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
