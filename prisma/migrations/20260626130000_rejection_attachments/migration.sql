-- Images a reviewer attaches to a rejection comment (screenshots/photos of
-- what's wrong). Bytes live in Postgres — same pattern as prod_spec_images and
-- job_assets.pdf — served back only behind the admin rejection log. Purely
-- additive (new table), idempotent, safe to re-run via `prisma migrate deploy`.
-- No change to the hot "rejection_tickets" table.
CREATE TABLE IF NOT EXISTS "rejection_attachments" (
  "id"           TEXT NOT NULL,
  "ticketId"     TEXT NOT NULL,
  "data"         BYTEA NOT NULL,
  "mimeType"     TEXT NOT NULL,
  "fileName"     TEXT NOT NULL,
  "byteSize"     INTEGER NOT NULL,
  "uploadedById" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rejection_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "rejection_attachments_ticketId_idx" ON "rejection_attachments"("ticketId");

-- FK with cascade — attachments vanish when their ticket thread is deleted.
-- (uploadedById is an audit-only scalar — intentionally no FK to users.)
DO $$ BEGIN
  ALTER TABLE "rejection_attachments" ADD CONSTRAINT "rejection_attachments_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "rejection_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
