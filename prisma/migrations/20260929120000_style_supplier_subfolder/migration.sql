-- Per-style subfolder inside the PO's "APPROVED LAYOUTS" folder.
--
-- Approved layouts used to land flat in "<PO> - <customer> - <supplier>/
-- APPROVED LAYOUTS/", shared by every style on the PO. From the style-subfolder
-- PO cutoff on, each style/colourway gets its own "<style> - <colour>" folder in
-- there. This column pins the name the style delivers into, so a later Monday
-- colour edit can't silently start a second folder. NULL = the flat layout.
-- Additive and nullable: every existing style keeps delivering exactly where it
-- does today.
ALTER TABLE "Style" ADD COLUMN "supplierSubfolderName" TEXT;
