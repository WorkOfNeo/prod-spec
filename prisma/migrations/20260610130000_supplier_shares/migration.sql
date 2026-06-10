-- Supplier share — the per-approval, supplier-facing link. Created when a
-- job is published (approved); the supplier email carries its URL
-- (/s/<token>) plus a 4-digit PIN. The supplier unlocks with email + PIN to
-- view the approved PDFs; a successful unlock records a visit, surfaced on
-- the Style's prod-spec tab. One share per published job (jobId unique).
-- Additive table; existing behaviour is unaffected until a share is written.

-- CreateTable
CREATE TABLE "supplier_shares" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "firstVisitedAt" TIMESTAMP(3),
    "lastVisitedAt" TIMESTAMP(3),
    "visitCount" INTEGER NOT NULL DEFAULT 0,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_shares_token_key" ON "supplier_shares"("token");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_shares_jobId_key" ON "supplier_shares"("jobId");

-- CreateIndex
CREATE INDEX "supplier_shares_styleId_idx" ON "supplier_shares"("styleId");

-- AddForeignKey
ALTER TABLE "supplier_shares" ADD CONSTRAINT "supplier_shares_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_shares" ADD CONSTRAINT "supplier_shares_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
