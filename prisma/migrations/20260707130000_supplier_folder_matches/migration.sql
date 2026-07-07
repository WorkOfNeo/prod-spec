-- PO folder is searched, never created (employees own it). When several folders
-- match one PO, we flag AMBIGUOUS and stash the competing folders so a reviewer
-- can open each and delete the extra. Idempotent (IF NOT EXISTS).
ALTER TABLE "supplier_send_queue_items"
  ADD COLUMN IF NOT EXISTS "sharePointFolderMatches" TEXT;
