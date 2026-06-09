-- App settings — global, app-wide key-value config store. Additive table;
-- existing behaviour is unaffected until a setting row is written. Backs
-- the "auto-generate outputs" master switch (key: autoGenerateEnabled),
-- read by the auto-enqueue paths (Monday style webhook, import promotion).
-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);
