-- WS2a: nightly supplier-send queue. One row per approved (style, output).
-- Additive, idempotent (IF NOT EXISTS) so it's safe + re-runnable via
-- `prisma migrate deploy` against the live Railway DB.
CREATE TABLE IF NOT EXISTS "supplier_send_queue_items" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "jobAssetId" TEXT,
    "docType" TEXT NOT NULL,
    "displayName" TEXT,
    "customerId" TEXT NOT NULL,
    "supplierId" TEXT,
    "poSeq" INTEGER,
    "sharePointStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "sharePointUrl" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "emailLogId" TEXT,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "supplier_send_queue_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "supplier_send_queue_items_styleId_variantKey_key"
    ON "supplier_send_queue_items" ("styleId", "variantKey");
CREATE INDEX IF NOT EXISTS "supplier_send_queue_items_supplierId_sentAt_idx"
    ON "supplier_send_queue_items" ("supplierId", "sentAt");
CREATE INDEX IF NOT EXISTS "supplier_send_queue_items_sentAt_idx"
    ON "supplier_send_queue_items" ("sentAt");
CREATE INDEX IF NOT EXISTS "supplier_send_queue_items_customerId_idx"
    ON "supplier_send_queue_items" ("customerId");
