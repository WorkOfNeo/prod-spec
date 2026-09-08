-- The all-PO folder sweep: one run, and one row per purchase order in it.
--
-- The PO list is written up front and each row filled in as its folder is
-- checked, which is what makes an hour-long run survive a deploy: resuming is
-- "the rows still marked pending". Findings are stored as JSON so the
-- cross-order review can group by fault type without going back to SharePoint.
--
-- Nothing in these tables is ever acted on directly. A scan is stale the moment
-- it is written; acting on a finding goes through the per-PO page, whose apply
-- re-reads the live folder first.
CREATE TABLE "folder_check_sweeps" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "minPo" INTEGER,
    "totalPos" INTEGER NOT NULL DEFAULT 0,
    "checkedPos" INTEGER NOT NULL DEFAULT 0,
    "unreadablePos" INTEGER NOT NULL DEFAULT 0,
    "erroredPos" INTEGER NOT NULL DEFAULT 0,
    "posWithFindings" INTEGER NOT NULL DEFAULT 0,
    "flaggedFiles" INTEGER NOT NULL DEFAULT 0,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "startedById" TEXT,
    "startedByEmail" TEXT,
    "error" TEXT,

    CONSTRAINT "folder_check_sweeps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "folder_check_sweeps_status_startedAt_idx" ON "folder_check_sweeps"("status", "startedAt");
CREATE INDEX "folder_check_sweeps_startedAt_idx" ON "folder_check_sweeps"("startedAt");

CREATE TABLE "folder_check_sweep_pos" (
    "id" TEXT NOT NULL,
    "sweepId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "poSeq" INTEGER,
    "supplierName" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "message" TEXT,
    "folderUrl" TEXT,
    "styleCount" INTEGER NOT NULL DEFAULT 0,
    "scannedFiles" INTEGER NOT NULL DEFAULT 0,
    "flaggedFiles" INTEGER NOT NULL DEFAULT 0,
    "findings" JSONB,
    "kindCounts" JSONB,
    "notes" JSONB,
    "checkedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "folder_check_sweep_pos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "folder_check_sweep_pos_sweepId_supplierId_poNumber_key" ON "folder_check_sweep_pos"("sweepId", "supplierId", "poNumber");
CREATE INDEX "folder_check_sweep_pos_sweepId_state_idx" ON "folder_check_sweep_pos"("sweepId", "state");
CREATE INDEX "folder_check_sweep_pos_sweepId_flaggedFiles_idx" ON "folder_check_sweep_pos"("sweepId", "flaggedFiles");

ALTER TABLE "folder_check_sweep_pos" ADD CONSTRAINT "folder_check_sweep_pos_sweepId_fkey" FOREIGN KEY ("sweepId") REFERENCES "folder_check_sweeps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
