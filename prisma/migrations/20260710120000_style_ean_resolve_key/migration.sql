-- Fingerprint of the inputs the last PO→EAN scrape resolved against (PO number,
-- style number, Customer Item No, Colour code, size run). The job runner
-- recomputes it before each render and re-resolves when it no longer matches
-- the current Monday snapshot — catching Sizes / Colour-code edits that (unlike
-- a PO change) don't re-queue a resolve at ingest. Nullable; the runner
-- backfills existing rows on their next render without a forced re-scrape.
-- Idempotent.
ALTER TABLE "styles"
  ADD COLUMN IF NOT EXISTS "eanResolveKey" TEXT;
