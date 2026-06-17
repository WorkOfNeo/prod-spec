-- Numeric PO sequence for the automation cutoff. poSeq = the LAST digit run of
-- poNumber ("C-PO63144" -> 63144), matching parsePoNumberValue() so auto-scrape
-- + the generation sweep can filter "PO >= cutoff" with a plain indexed compare
-- instead of parsing strings per row.
--
-- Additive column + index + one-time backfill. The backfill regex
-- '(\d+)\D*$' captures the last digit run (a digit run followed only by
-- non-digits to end-of-string) — the SQL equivalent of parsePoNumberValue's
-- /(\d+)(?!.*\d)/. Idempotent (WHERE poSeq IS NULL), safe to re-run via
-- `prisma migrate deploy`.
ALTER TABLE "styles" ADD COLUMN IF NOT EXISTS "poSeq" INTEGER;

CREATE INDEX IF NOT EXISTS "styles_eanStatus_poSeq_idx" ON "styles"("eanStatus", "poSeq");

UPDATE "styles"
SET "poSeq" = (regexp_match("poNumber", '(\d+)\D*$'))[1]::integer
WHERE "poNumber" IS NOT NULL AND "poNumber" ~ '\d' AND "poSeq" IS NULL;
