-- Style diagnostics groundwork: persist the PO scrape dump, and index the name
-- so "same style name, different PO" lookalikes are cheap to find.
--
-- 1) poScrapeSnapshot — the trimmed per-section dump of the last PO scrape
--    (see src/lib/po/scrape-snapshot.ts). This was previously computed on every
--    scrape as EanDiagnostics.poSections and then deliberately dropped before
--    the Log write, so "what did this PO actually contain?" was unanswerable
--    once the runner finished. Nullable + additive: rows scraped before this
--    column existed stay null and simply show nothing until their next resolve.
ALTER TABLE "styles" ADD COLUMN IF NOT EXISTS "poScrapeSnapshot" JSONB;

-- 2) styles_name_idx — Monday carries the SAME style name on several Pre-Order
--    rows (one per PO). Reviewers opening the wrong row is the single biggest
--    source of "something's up with this style" reports, so the lookalike
--    lookup runs on list renders and needs an index. Plain (not CONCURRENTLY):
--    prisma migrate wraps each migration in a transaction, and the styles table
--    is small enough that the brief lock is not a concern.
CREATE INDEX IF NOT EXISTS "styles_name_idx" ON "styles"("name");
