-- Admin "fix note" on a rejection ticket: the comment the admin adds when
-- pressing "Mark fixed & notify", carried into the reviewer's re-review
-- notification + email. Purely additive (nullable column), idempotent, safe
-- to re-run via `prisma migrate deploy`.
ALTER TABLE "rejection_tickets" ADD COLUMN IF NOT EXISTS "fixNote" TEXT;
