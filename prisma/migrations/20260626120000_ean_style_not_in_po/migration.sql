-- Reject outcome for the PO→EAN scrape: the PO PDF was found and parsed and it
-- carries barcodes, but none of its style sections matches the style's style
-- number. Surfaced on /po-eans with its own badge so a multi-style PO can no
-- longer leak another style's EANs through the "use all items" fallback.
-- IF NOT EXISTS keeps the deploy idempotent against the live Railway DB.
ALTER TYPE "StyleEanStatus" ADD VALUE IF NOT EXISTS 'STYLE_NOT_IN_PO';
