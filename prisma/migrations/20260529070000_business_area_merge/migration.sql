-- Aliasing for BusinessArea: a row whose `mergedIntoId` is set is treated
-- as an alias of the target. Ingest follows the redirect, so future
-- Monday items with the alias mondayValue land on the canonical BA's
-- Styles / ProdSpecs without re-creating a separate hierarchy.
ALTER TABLE "business_areas" ADD COLUMN "mergedIntoId" TEXT;
ALTER TABLE "business_areas"
  ADD CONSTRAINT "business_areas_mergedIntoId_fkey"
  FOREIGN KEY ("mergedIntoId") REFERENCES "business_areas"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "business_areas_mergedIntoId_idx" ON "business_areas"("mergedIntoId");
