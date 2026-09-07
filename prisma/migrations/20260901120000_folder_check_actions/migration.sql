-- The audit trail for the /checks page: one row per file the app was asked to
-- delete from or rename inside a supplier's SharePoint folder, written for
-- every attempt (done / already-gone / conflict / refused / failed).
--
-- Deleting from a supplier's folder has no undo we control, so this table is
-- the only record that the file ever existed. userId is a plain column with no
-- foreign key on purpose — an audit record must outlive the account.
CREATE TABLE "folder_check_actions" (
    "id" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "newFileName" TEXT,
    "driveId" TEXT NOT NULL,
    "driveItemId" TEXT NOT NULL,
    "folderUrl" TEXT,
    "location" TEXT NOT NULL,
    "verdict" TEXT,
    "outcome" TEXT NOT NULL,
    "error" TEXT,
    "userId" TEXT,
    "userEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folder_check_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "folder_check_actions_poNumber_createdAt_idx" ON "folder_check_actions"("poNumber", "createdAt");
CREATE INDEX "folder_check_actions_createdAt_idx" ON "folder_check_actions"("createdAt");
