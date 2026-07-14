-- Fingerprint of the OUTPUT's render-affecting config (dims / pins / carton
-- barcode / info-area size) at the moment this asset was built. The ProdSpec
-- Outputs-tab rerun surfaces recompute it from the current spec and compare: a
-- mismatch on a still-awaiting-review output means the admin edited the output
-- since it rendered, so it counts as "changed" and re-runnable (approved
-- outputs are never re-run). Nullable; existing rows read as "unknown → not
-- changed" until re-rendered or stamped by scripts/backfill-output-config-key.ts.
-- Idempotent (safe + re-runnable via `prisma migrate deploy`).
ALTER TABLE "job_assets"
  ADD COLUMN IF NOT EXISTS "outputConfigKey" TEXT;
