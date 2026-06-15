-- Info-area sizes: allow fractional millimetres (e.g. 27.5 mm). Widen the
-- two integer dimension columns to double precision. Lossless for existing
-- integer rows. Guarded so it's a no-op once already widened — safe to
-- re-run against the live database.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'info_area_sizes' AND column_name = 'widthMm' AND data_type = 'integer'
  ) THEN
    ALTER TABLE "info_area_sizes" ALTER COLUMN "widthMm" TYPE DOUBLE PRECISION;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'info_area_sizes' AND column_name = 'heightMm' AND data_type = 'integer'
  ) THEN
    ALTER TABLE "info_area_sizes" ALTER COLUMN "heightMm" TYPE DOUBLE PRECISION;
  END IF;
END $$;
