-- One row per (supplier, purchase order): the last known delivery state of that
-- PO's APPROVED LAYOUTS folder. Written by the po-delivery cron sweep; read by
-- the fleet list. Counts only — the detail page re-checks live.
CREATE TABLE "po_delivery_checks" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "poSeq" INTEGER,
    "supplierName" TEXT,
    "state" TEXT NOT NULL,
    "message" TEXT,
    "folderUrl" TEXT,
    "styleCount" INTEGER NOT NULL DEFAULT 0,
    "expectedDocs" INTEGER NOT NULL DEFAULT 0,
    "deliveredDocs" INTEGER NOT NULL DEFAULT 0,
    "missingDocs" INTEGER NOT NULL DEFAULT 0,
    "renamedDocs" INTEGER NOT NULL DEFAULT 0,
    "collisionDocs" INTEGER NOT NULL DEFAULT 0,
    "strayFiles" INTEGER NOT NULL DEFAULT 0,
    "staleFiles" INTEGER NOT NULL DEFAULT 0,
    "fullyDelivered" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "po_delivery_checks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "po_delivery_checks_supplierId_poNumber_key" ON "po_delivery_checks"("supplierId", "poNumber");
CREATE INDEX "po_delivery_checks_fullyDelivered_poSeq_idx" ON "po_delivery_checks"("fullyDelivered", "poSeq");
CREATE INDEX "po_delivery_checks_checkedAt_idx" ON "po_delivery_checks"("checkedAt");
