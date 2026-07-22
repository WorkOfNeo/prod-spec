-- Manual EAN override on the style page: hide over-included EANs and add
-- missing ones. Additive + backward-compatible (defaults), so existing code
-- that ignores these columns is unaffected.
ALTER TABLE "style_eans" ADD COLUMN "excluded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "style_eans" ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false;
