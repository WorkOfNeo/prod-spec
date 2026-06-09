-- Care labels — DB-managed care-instruction lines for care-label-02.
-- Each row is one line; print order is sortOrder. Per-language text comes
-- from the Translation dictionary at render time (sourceText is the key).
-- Visibility is conditional on a style's wash-care symbol codes
-- (showIfSymbols / hideIfSymbols). Additive table; existing renders are
-- unaffected until rows are seeded.
-- CreateTable
CREATE TABLE "care_labels" (
    "id" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "showIfSymbols" JSONB NOT NULL DEFAULT '[]',
    "hideIfSymbols" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "care_labels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "care_labels_active_idx" ON "care_labels"("active");
