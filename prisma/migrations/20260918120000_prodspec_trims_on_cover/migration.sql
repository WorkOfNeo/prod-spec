-- Per-ProdSpec opt-in to the trims layer on the cover page.
--
-- Additive, and DEFAULT false, so every existing spec keeps rendering exactly
-- the cover it renders today. Resolution against the global AppSetting is OR:
-- this column can only ever turn the layer ON for a spec, never off.
ALTER TABLE "prod_specs" ADD COLUMN IF NOT EXISTS "trimsOnCoverEnabled" BOOLEAN NOT NULL DEFAULT false;
