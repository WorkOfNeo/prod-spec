-- Per-style colour source for repeat-per-EAN rendering. When true, per-EAN
-- barcode rows bind {{colourName}} to the Style board colour instead of the
-- colour parsed from each PO variant label. Additive + backward-compatible
-- (defaults false = the historical PO-colour behaviour), so existing code that
-- ignores the column is unaffected.
ALTER TABLE "styles" ADD COLUMN IF NOT EXISTS "useStyleBoardColour" BOOLEAN NOT NULL DEFAULT false;
