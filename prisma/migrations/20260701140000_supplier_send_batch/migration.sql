-- WS2b: nightly supplier-send batch audit. Additive, idempotent.
CREATE TABLE IF NOT EXISTS "supplier_send_batches" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'midnight',
    "status" TEXT NOT NULL DEFAULT 'DRY_RUN',
    "supplierCount" INTEGER NOT NULL DEFAULT 0,
    "outputCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "perSupplier" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "supplier_send_batches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "supplier_send_batches_createdAt_idx"
    ON "supplier_send_batches" ("createdAt");
