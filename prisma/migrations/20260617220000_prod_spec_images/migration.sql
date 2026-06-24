-- Images uploaded for the ProdSpec "General information" page. Bytes live in
-- Postgres (same pattern as job_assets.pdf) — referenced from
-- prod_specs.generalInfoMd by a short serve URL and inlined to a data URL at
-- PDF render time. Purely additive (new table), idempotent, safe to re-run via
-- `prisma migrate deploy`. No change to the hot "prod_specs" table.
CREATE TABLE IF NOT EXISTS "prod_spec_images" (
  "id"         TEXT NOT NULL,
  "prodSpecId" TEXT NOT NULL,
  "data"       BYTEA NOT NULL,
  "mimeType"   TEXT NOT NULL,
  "fileName"   TEXT NOT NULL,
  "byteSize"   INTEGER NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "prod_spec_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "prod_spec_images_prodSpecId_idx" ON "prod_spec_images"("prodSpecId");

-- FK with cascade — images vanish when their prod spec is deleted.
DO $$ BEGIN
  ALTER TABLE "prod_spec_images" ADD CONSTRAINT "prod_spec_images_prodSpecId_fkey"
    FOREIGN KEY ("prodSpecId") REFERENCES "prod_specs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
