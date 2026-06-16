-- Per-output supplier delivery (per-output refactor, phase 3). One row per
-- (style × output) tracking when a single approved output was delivered to the
-- supplier, so a re-run doesn't re-notify. Purely additive — a new table, no
-- existing rows touched — so it applies cleanly to the already-live database via
-- `prisma migrate deploy`. Written idempotently (IF NOT EXISTS) per repo
-- convention and safe to re-run.

CREATE TABLE IF NOT EXISTS "output_deliveries" (
  "id" TEXT NOT NULL,
  "styleId" TEXT NOT NULL,
  "variantKey" TEXT NOT NULL,
  "jobAssetId" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "emailLogId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "output_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "output_deliveries_styleId_variantKey_key"
  ON "output_deliveries" ("styleId", "variantKey");

CREATE INDEX IF NOT EXISTS "output_deliveries_styleId_idx"
  ON "output_deliveries" ("styleId");
