-- Care-clause suppression mapping, stored per wash-care symbol. A
-- restrictive symbol (e.g. "Do not iron") lists the care-instruction
-- clause ids it removes on care-label-02. Clause ids are code constants
-- (STANDARD_CARE_CLAUSES); this column is edited in the admin UI at
-- /settings/washcare-symbols. Additive, defaulted — existing rows get an
-- empty array (suppress nothing), so the full instruction keeps rendering.
-- AlterTable
ALTER TABLE "wash_symbols" ADD COLUMN "suppressesCareClauses" JSONB NOT NULL DEFAULT '[]';
