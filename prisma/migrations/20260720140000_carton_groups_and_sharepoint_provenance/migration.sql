-- SharePoint provenance on the delivered asset. Until now the uploaded file's
-- webUrl only survived inside logs.payload, so nothing could link to the file
-- or sort by "newest delivered".
ALTER TABLE "job_assets" ADD COLUMN "spFileUrl" TEXT;
ALTER TABLE "job_assets" ADD COLUMN "spFileId" TEXT;
ALTER TABLE "job_assets" ADD COLUMN "spUploadedAt" TIMESTAMP(3);

CREATE INDEX "job_assets_spUploadedAt_idx" ON "job_assets"("spUploadedAt");

-- Multi-style carton groups.
CREATE TABLE "carton_groups" (
    "id" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "mainStyleId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "totalCartons" INTEGER,
    "fileName" TEXT NOT NULL,
    "jobId" TEXT,
    "jobAssetId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "removedReason" TEXT,

    CONSTRAINT "carton_groups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "carton_groups_poNumber_idx" ON "carton_groups"("poNumber");
CREATE INDEX "carton_groups_customerId_idx" ON "carton_groups"("customerId");

CREATE TABLE "carton_group_styles" (
    "cartonGroupId" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,

    CONSTRAINT "carton_group_styles_pkey" PRIMARY KEY ("cartonGroupId","styleId")
);

CREATE INDEX "carton_group_styles_styleId_idx" ON "carton_group_styles"("styleId");

ALTER TABLE "carton_group_styles"
  ADD CONSTRAINT "carton_group_styles_cartonGroupId_fkey"
  FOREIGN KEY ("cartonGroupId") REFERENCES "carton_groups"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill SharePoint provenance from the publish logs. Each row of
-- logs.payload->'uploaded' is { id, name, webUrl, docType }; `name` is the
-- asset's fileName, which is unique within a job.
UPDATE "job_assets" a
SET "spFileUrl"    = u."webUrl",
    "spFileId"     = u."id",
    "spUploadedAt" = l."createdAt"
FROM "logs" l
CROSS JOIN LATERAL jsonb_array_elements(l."payload"::jsonb -> 'uploaded')
  AS e(elem)
CROSS JOIN LATERAL (
  SELECT elem ->> 'webUrl' AS "webUrl",
         elem ->> 'id'     AS "id",
         elem ->> 'name'   AS "name"
) u
WHERE l."jobId" = a."jobId"
  AND u."name" = a."fileName"
  AND u."webUrl" IS NOT NULL
  AND a."spFileUrl" IS NULL
  AND l."payload" IS NOT NULL
  AND jsonb_typeof(l."payload"::jsonb -> 'uploaded') = 'array';
