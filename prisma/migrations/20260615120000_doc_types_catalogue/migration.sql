-- Doc types become a UI-managed catalogue (doc_types table) instead of a
-- Postgres enum, so operators can add types without a migration.
-- Idempotent: every statement is safe to re-run.

-- 1. The catalogue table, seeded with the six enum values in use today.
CREATE TABLE IF NOT EXISTS "doc_types" (
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_types_pkey" PRIMARY KEY ("value")
);

INSERT INTO "doc_types" ("value", "label", "sortOrder") VALUES
    ('WASHCARE',       'Wash care',       0),
    ('CARE_LABEL',     'Care label',      1),
    ('STICKER',        'Sticker',         2),
    ('HANGTAG',        'Hang tag',        3),
    ('CARTON_MARKING', 'Carton marking',  4),
    ('COLOUR_STICKER', 'Colour sticker',  5)
ON CONFLICT ("value") DO NOTHING;

-- 2. docType columns: enum -> plain text. The default must be dropped
--    before the type change (an enum default can't be cast automatically)
--    and re-added as text afterwards. COVER / GENERAL_INFO values on
--    job_assets are preserved verbatim — they stay code-managed framing
--    pages, not catalogue rows.
ALTER TABLE "output_layouts" ALTER COLUMN "docType" DROP DEFAULT;
ALTER TABLE "output_layouts" ALTER COLUMN "docType" TYPE TEXT USING "docType"::text;
ALTER TABLE "output_layouts" ALTER COLUMN "docType" SET DEFAULT 'STICKER';

ALTER TABLE "templates"  ALTER COLUMN "docType" TYPE TEXT USING "docType"::text;
ALTER TABLE "job_assets" ALTER COLUMN "docType" TYPE TEXT USING "docType"::text;

-- 3. The enum itself — nothing references it after step 2.
DROP TYPE IF EXISTS "DocType";
