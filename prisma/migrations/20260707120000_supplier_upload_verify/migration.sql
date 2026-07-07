-- WS4: self-heal verify for supplier-folder uploads.
-- Idempotent (IF NOT EXISTS) — safe against the live Railway DB.

-- The "APPROVED LAYOUTS" subfolder the PDF(s) landed in, persisted so
-- /settings/approved can deep-link straight to the folder and the verify pass
-- re-checks the exact location without re-deriving it.
ALTER TABLE "supplier_send_queue_items"
  ADD COLUMN IF NOT EXISTS "sharePointFolderUrl" TEXT;

-- When the recurring sweep last CONFIRMED this row's file is actually in the
-- folder. UPLOADED is otherwise set on a non-throwing Graph PUT and never
-- re-checked; null = never verified / just re-armed.
ALTER TABLE "supplier_send_queue_items"
  ADD COLUMN IF NOT EXISTS "sharePointVerifiedAt" TIMESTAMP(3);

-- The verify pass scans UPLOADED rows oldest-verified-first (nulls first).
CREATE INDEX IF NOT EXISTS "supplier_send_queue_items_sharePointStatus_sharePointVerifiedAt_idx"
  ON "supplier_send_queue_items" ("sharePointStatus", "sharePointVerifiedAt");
