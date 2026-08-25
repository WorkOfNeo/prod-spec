-- Cover manifest fingerprint, so the regen sweep can rebuild only the covers
-- whose printed manifest actually changed instead of every cover in the book.
ALTER TABLE "job_assets" ADD COLUMN IF NOT EXISTS "coverManifestKey" TEXT;

-- Separates "push this file" from "mention it in tonight's digest". Existing
-- rows keep today's behaviour (both).
ALTER TABLE "supplier_send_queue_items" ADD COLUMN IF NOT EXISTS "notifySupplier" BOOLEAN NOT NULL DEFAULT true;
