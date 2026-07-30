-- Output-set versioning, so a newly ADDED output reaches styles that already
-- generated. The backlog sweep only ever considered styles in PENDING/READY,
-- which made every already-generated style permanently invisible to a new
-- output; comparing these two counters gives the sweep a cheap, indexable
-- second candidate class.

-- Bumped by PATCH /api/admin/prod-specs/[id] when the ENABLED output set gains
-- a key. Removals do not bump — nothing needs generating for a deleted output.
ALTER TABLE "prod_specs" ADD COLUMN "outputsVersion" INTEGER NOT NULL DEFAULT 0;

-- The spec version this style was last evaluated against by the generation
-- gate. Behind ⇒ unchecked declared outputs exist. Existing rows start at 0,
-- same as the spec, so this migration alone re-sweeps nothing; the first real
-- output addition is what creates the gap.
ALTER TABLE "styles" ADD COLUMN "outputsCheckedVersion" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "styles_prodSpecId_outputsCheckedVersion_idx"
  ON "styles"("prodSpecId", "outputsCheckedVersion");

-- Distinguishes "generated because an admin added an output to the spec" from a
-- bulk-run click in the per-style history and the ProdSpec run list.
ALTER TYPE "TriggerSource" ADD VALUE IF NOT EXISTS 'SPEC_OUTPUT_ADDED';
