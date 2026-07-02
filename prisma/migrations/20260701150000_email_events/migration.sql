-- Delivery: Resend delivery/open events. Additive, idempotent.
CREATE TABLE IF NOT EXISTS "email_events" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "emailLogId" TEXT,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "email_events_providerId_idx" ON "email_events" ("providerId");
CREATE INDEX IF NOT EXISTS "email_events_emailLogId_idx" ON "email_events" ("emailLogId");
