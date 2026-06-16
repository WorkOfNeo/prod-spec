-- Per-output auto-approve. Additive + idempotent: assets from a layout with
-- autoApprove = true skip the manual per-asset review queue (runner marks
-- them APPROVED at generation when print-safe). Defaults false so existing
-- layouts keep their current manual-review behaviour.
ALTER TABLE "output_layouts" ADD COLUMN IF NOT EXISTS "autoApprove" BOOLEAN NOT NULL DEFAULT false;
