-- Follow-up messaging on a past supplier-send batch (/settings/approved →
-- "Recent sends" → "Send email to suppliers"). Lets an admin write one custom
-- subject + body and send it to the suppliers a given batch reached — the
-- correction channel for a batch that went out wrong, which until now meant
-- mailing 40+ suppliers by hand from Outlook.
--
-- SUPPLIER_MESSAGE keeps those emails distinguishable from the nightly
-- SUPPLIER_APPROVAL digest in the activity table on /settings/notifications.
-- Additive + idempotent (ADD VALUE IF NOT EXISTS, Postgres 12+); safe to re-run
-- via `prisma migrate deploy`.
ALTER TYPE "EmailType" ADD VALUE IF NOT EXISTS 'SUPPLIER_MESSAGE';

-- Stamped on the batch when a follow-up goes out, so the row can say "follow-up
-- sent to N suppliers" and a second accidental send to the same 40 suppliers is
-- something you have to do on purpose.
ALTER TABLE "supplier_send_batches"
  ADD COLUMN IF NOT EXISTS "followUpAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "followUpCount" INTEGER NOT NULL DEFAULT 0;
