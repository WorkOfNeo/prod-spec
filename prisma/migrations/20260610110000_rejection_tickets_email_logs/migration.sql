-- Post-generation email flow: rejection tickets + email logs.
--
-- rejection_tickets — admin work-log behind /settings/rejection-log. One
-- ticket per rejected output (style × variantKey thread) with SNAPSHOT
-- columns: the runner deletes all job_assets on every re-run, so the
-- ticket must carry its own context (output name, customer, BA, PO,
-- comment) rather than lean on the asset row.
--
-- email_logs — every outbound email attempt (real or simulated), written
-- by src/lib/email/dispatch.ts. Attachment BYTES are never stored, only
-- [{ filename, bytes }] metadata; bodies are a few KB of HTML.
--
-- TriggerSource gains TICKET_RERUN (silent iteration — runner suppresses
-- the review-ready email) and TICKET_FIX (fix endpoint sends the dedicated
-- TICKET_FIXED email itself). Additive; existing rows unaffected.

-- AlterEnum
ALTER TYPE "TriggerSource" ADD VALUE IF NOT EXISTS 'TICKET_RERUN';
ALTER TYPE "TriggerSource" ADD VALUE IF NOT EXISTS 'TICKET_FIX';

-- CreateEnum
CREATE TYPE "RejectionTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'FIXED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "EmailType" AS ENUM ('REVIEW_READY', 'TICKET_FIXED', 'SUPPLIER_APPROVAL');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('SENT', 'SIMULATED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "rejection_tickets" (
    "id" TEXT NOT NULL,
    "status" "RejectionTicketStatus" NOT NULL DEFAULT 'OPEN',
    "styleId" TEXT NOT NULL,
    "jobId" TEXT,
    "jobAssetId" TEXT,
    "variantKey" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "outputName" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "businessArea" TEXT,
    "poNumber" TEXT,
    "styleName" TEXT NOT NULL,
    "styleNumber" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "reportedById" TEXT NOT NULL,
    "reopenedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "fixedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rejection_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_logs" (
    "id" TEXT NOT NULL,
    "type" "EmailType" NOT NULL,
    "status" "EmailStatus" NOT NULL,
    "to" TEXT NOT NULL,
    "cc" TEXT,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "providerId" TEXT,
    "error" TEXT,
    "jobId" TEXT,
    "styleId" TEXT,
    "ticketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rejection_tickets_status_createdAt_idx" ON "rejection_tickets"("status", "createdAt");

-- CreateIndex
CREATE INDEX "rejection_tickets_styleId_variantKey_idx" ON "rejection_tickets"("styleId", "variantKey");

-- CreateIndex
CREATE INDEX "email_logs_createdAt_idx" ON "email_logs"("createdAt");

-- CreateIndex
CREATE INDEX "email_logs_jobId_idx" ON "email_logs"("jobId");

-- AddForeignKey
ALTER TABLE "rejection_tickets" ADD CONSTRAINT "rejection_tickets_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rejection_tickets" ADD CONSTRAINT "rejection_tickets_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rejection_tickets" ADD CONSTRAINT "rejection_tickets_jobAssetId_fkey" FOREIGN KEY ("jobAssetId") REFERENCES "job_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rejection_tickets" ADD CONSTRAINT "rejection_tickets_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
