-- Bundle framing pages: every generated job gets an A4 cover page (lists
-- the bundle's documents + their mm dimensions) and, when the ProdSpec
-- carries markdown, an A4 "General information" page. Purely additive —
-- one nullable column + two enum values, no existing rows touched — so it
-- applies cleanly to the already-live database via `prisma migrate deploy`.
-- Written idempotently to match the repo convention.

ALTER TABLE "prod_specs" ADD COLUMN IF NOT EXISTS "generalInfoMd" TEXT;

-- PG12+ allows ALTER TYPE ... ADD VALUE inside a transaction as long as the
-- new value isn't used in the same transaction — nothing below references
-- these, so prisma's per-migration transaction is safe.
ALTER TYPE "DocType" ADD VALUE IF NOT EXISTS 'COVER';
ALTER TYPE "DocType" ADD VALUE IF NOT EXISTS 'GENERAL_INFO';
