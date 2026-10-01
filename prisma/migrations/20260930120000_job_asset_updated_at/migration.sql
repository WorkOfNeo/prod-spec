-- A version stamp on every job asset.
--
-- Cover pages are rebuilt IN PLACE: approving an output or hand-approving a
-- manually supplied packaging line overwrites the bytes of the same JobAsset
-- row. The thumbnail endpoint cached its PNG per asset id (in memory, and for a
-- day in the browser), so a rebuilt cover kept showing its old picture — the
-- "I approved it and the cover still says waiting" report. updatedAt is what
-- the preview and thumbnail URLs now carry, so a rebuilt cover gets a new URL.
--
-- The default fills existing rows without a table rewrite (CURRENT_TIMESTAMP
-- is not volatile), and Prisma's @updatedAt maintains it from here on.
ALTER TABLE "job_assets"
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
