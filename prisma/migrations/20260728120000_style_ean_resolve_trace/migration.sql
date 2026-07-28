-- Snapshot of the last EAN resolve: which source won, what the Monday barcode
-- columns contained, why the PO scrape produced nothing. Latest run only —
-- overwritten each resolve. Nullable + no default, so existing rows are
-- untouched and the UI can distinguish "never resolved since this shipped"
-- from "resolved and found nothing".
ALTER TABLE "styles" ADD COLUMN "eanResolveTrace" JSONB;
