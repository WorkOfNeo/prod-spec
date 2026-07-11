-- Last SharePoint push error per supplier-send queue row, human-readable
-- ("400 · The file name is invalid", "403 · write not granted"). Lets
-- /settings/approved say WHY a row floated instead of a bare "gave up (3×)".
-- Written best-effort in its own guarded update, cleared on UPLOADED. Idempotent.
ALTER TABLE "supplier_send_queue_items"
  ADD COLUMN IF NOT EXISTS "sharePointError" TEXT;
