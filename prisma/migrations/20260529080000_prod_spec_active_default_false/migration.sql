-- Auto-created ProdSpec rows should land inactive ("needs configuration"
-- on the /import dashboard) until an admin explicitly approves them.
-- Activation now happens implicitly on any non-active field change via
-- the PATCH endpoint, or explicitly via the toggle.
ALTER TABLE "prod_specs" ALTER COLUMN "active" SET DEFAULT false;

-- Backfill: existing scaffolds with no outputs configured are exactly
-- what the new "Needs configuration" filter is meant to catch. Flip them
-- inactive so the dashboard reflects state on next reload. Untouched
-- ProdSpecs that already have outputs stay active.
UPDATE "prod_specs"
SET "active" = false
WHERE
  ("outputs"::text = '[]' OR "outputs"::text = 'null' OR "outputs" IS NULL)
  AND "active" = true;
