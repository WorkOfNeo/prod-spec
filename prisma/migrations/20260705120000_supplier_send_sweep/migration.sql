-- WS3: recurring supplier-upload sweep + digest folder links.
-- Idempotent (IF NOT EXISTS) — safe against the live Railway DB.

-- 3-strike float for SharePoint folder pushes, mirroring the EAN scrape cap.
ALTER TABLE "supplier_send_queue_items"
  ADD COLUMN IF NOT EXISTS "pushAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "supplier_send_queue_items"
  ADD COLUMN IF NOT EXISTS "lastPushAt" TIMESTAMP(3);

-- The style's subfolder inside the supplier's own SharePoint folder, captured
-- on first successful push; linked from the nightly supplier digest.
ALTER TABLE "styles"
  ADD COLUMN IF NOT EXISTS "supplierFolderUrl" TEXT;
