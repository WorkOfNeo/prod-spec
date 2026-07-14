-- Published Output Builder layout version the asset rendered from
-- (OutputLayout.version). The ProdSpec Outputs-tab rerun surfaces compare it to
-- the layout's current version so a re-published layout edit marks the affected
-- awaiting-review outputs "changed". Nullable; a null on either side is skipped
-- (coded variants + legacy rows), so no backfill is needed. Idempotent.
ALTER TABLE "job_assets"
  ADD COLUMN IF NOT EXISTS "outputContentVersion" INTEGER;
