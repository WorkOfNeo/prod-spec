-- Info Area Sizes: an admin-managed catalogue of named print sizes (mm) for
-- "info area" outputs, plus an `isInfoArea` flag on output layouts. Purely
-- additive — a new table + one defaulted column, no existing rows touched —
-- so it applies cleanly to the already-live database via `prisma migrate
-- deploy`. Written idempotently (IF NOT EXISTS everywhere) to match the repo
-- convention and stay safe to re-run.

-- 1. The catalogue table.
CREATE TABLE IF NOT EXISTS "info_area_sizes" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "widthMm" INTEGER NOT NULL,
  "heightMm" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "info_area_sizes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "info_area_sizes_active_idx" ON "info_area_sizes"("active");

-- 2. The per-layout info-area flag. Defaults false so every existing layout
--    keeps its current (fixed page-size) behaviour.
ALTER TABLE "output_layouts" ADD COLUMN IF NOT EXISTS "isInfoArea" BOOLEAN NOT NULL DEFAULT false;
