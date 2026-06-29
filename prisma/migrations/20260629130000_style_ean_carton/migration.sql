-- Per-row carton EAN on style_eans. A multi-colourway style lists each colour
-- as its own PO section with its own carton EAN, so the carton must be tracked
-- per (size×colour) row rather than as the single Style.cartonEan (which stays
-- as a representative for non-repeating outputs). Additive + nullable, so it's
-- backward-compatible with the live Railway DB (old code ignores the column).
ALTER TABLE "style_eans" ADD COLUMN IF NOT EXISTS "cartonEan" TEXT;
