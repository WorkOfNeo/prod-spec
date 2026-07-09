-- Operator-chosen PO folder for a style, when several folders in the supplier's
-- SharePoint match the PO. Employees own PO folders and may create duplicates;
-- the app never deletes/guesses — a user picks one and we send there. Idempotent.
ALTER TABLE "styles"
  ADD COLUMN IF NOT EXISTS "supplierPoFolderName" TEXT;
