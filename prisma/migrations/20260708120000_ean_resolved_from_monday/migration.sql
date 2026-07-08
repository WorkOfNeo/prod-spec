-- Terminal-good outcome for the PO→EAN scrape: the PO PDF couldn't produce
-- EANs and the retry budget was spent, so the barcodes were read from the
-- Pre-Order "Barcode Number" / "Carton Barcode number 1" text columns instead.
-- Badged distinctly on /po-eans so it's clear the codes came from Monday, not
-- the PO. IF NOT EXISTS keeps the deploy idempotent against the live Railway DB.
ALTER TYPE "StyleEanStatus" ADD VALUE IF NOT EXISTS 'RESOLVED_FROM_MONDAY';
