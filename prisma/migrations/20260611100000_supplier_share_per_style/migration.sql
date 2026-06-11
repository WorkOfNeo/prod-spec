-- Supplier share becomes ONE durable link per STYLE (was per job).
--
-- The link's token + PIN now stay stable across approvals; the portal
-- always serves the style's LATEST APPROVED version of each output, so a
-- re-approved correction "pushes through" to the same link. We therefore
-- drop the jobId pin (and its FK/unique) and make styleId unique.
--
-- Defensive dedupe first: if any style somehow has multiple shares, keep
-- the most recent and delete the rest, so the new unique index applies
-- cleanly. (At migration time there is at most one share per style.)
DELETE FROM "supplier_shares" a
USING "supplier_shares" b
WHERE a."styleId" = b."styleId"
  AND a."createdAt" < b."createdAt";

-- Drop the per-job linkage.
ALTER TABLE "supplier_shares" DROP CONSTRAINT IF EXISTS "supplier_shares_jobId_fkey";
DROP INDEX IF EXISTS "supplier_shares_jobId_key";
ALTER TABLE "supplier_shares" DROP COLUMN IF EXISTS "jobId";

-- One share per style.
CREATE UNIQUE INDEX "supplier_shares_styleId_key" ON "supplier_shares"("styleId");

-- The old non-unique styleId index is now redundant (the unique index
-- covers lookups). Drop it if it exists.
DROP INDEX IF EXISTS "supplier_shares_styleId_idx";
