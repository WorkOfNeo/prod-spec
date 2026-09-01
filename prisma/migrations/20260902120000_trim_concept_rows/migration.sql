-- Cover page packaging ROWS: the trim-concept catalogue, promoted from a code
-- constant to a table a person maintains.
--
-- DAY-ONE NO-OP BY CONSTRUCTION. The seed below is DEFAULT_TRIM_CONCEPTS in
-- src/lib/trims/concepts.ts, value for value, label for label, flag for flag,
-- including the two seeded wordings. The loader falls back to that same
-- constant when the table is empty or missing, so an install that has not run
-- this migration and one that has classify and print identically.
--
-- CreateTable
CREATE TABLE "trim_concept_rows" (
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "artwork" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "pendingStatus" TEXT,
    "deliveredStatus" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trim_concept_rows_pkey" PRIMARY KEY ("value")
);

CREATE INDEX "trim_concept_rows_active_sortOrder_idx" ON "trim_concept_rows"("active", "sortOrder");

-- Seed. ON CONFLICT DO NOTHING so a re-run (or an environment already seeded by
-- hand) is harmless and never overwrites an edited label or wording.
INSERT INTO "trim_concept_rows" ("value", "label", "artwork", "note", "pendingStatus", "deliveredStatus", "sortOrder", "builtIn", "active", "updatedAt") VALUES
  ('CARE_LABEL',      'Care label',             true,  'Wash Care Label, these are created to be printed on one paper, front and back', NULL, NULL, 10,  true, true, CURRENT_TIMESTAMP),
  ('CARTON_MARKING',  'Carton marking',         true,  NULL, NULL, NULL, 20,  true, true, CURRENT_TIMESTAMP),
  ('COLOUR_STICKER',  'Colour sticker',         true,  NULL, NULL, NULL, 30,  true, true, CURRENT_TIMESTAMP),
  ('HANGTAG',         'Hangtag',                true,  NULL, NULL, NULL, 40,  true, true, CURRENT_TIMESTAMP),
  -- A banderole cannot be drawn until the supplier photographs the samples, so
  -- "Waiting for Customer Information" points at the wrong party.
  ('BANDEROLE',       'Banderole',              true,  NULL, 'Awaiting Photo Samples from the supplier.', NULL, 50,  true, true, CURRENT_TIMESTAMP),
  ('NECK_PRINT',      'Neck print',             true,  NULL, NULL, NULL, 60,  true, true, CURRENT_TIMESTAMP),
  ('MAIN_LABEL',      'Main label',             true,  NULL, NULL, NULL, 70,  true, true, CURRENT_TIMESTAMP),
  ('SIZE_LABEL',      'Size label',             true,  NULL, NULL, NULL, 80,  true, true, CURRENT_TIMESTAMP),
  ('PRICE_STICKER',   'Price sticker',          true,  NULL, NULL, NULL, 90,  true, true, CURRENT_TIMESTAMP),
  ('BARCODE_STICKER', 'Barcode sticker',        true,  NULL, NULL, NULL, 100, true, true, CURRENT_TIMESTAMP),
  ('POLYBAG_STICKER', 'Polybag sticker',        true,  NULL, NULL, NULL, 110, true, true, CURRENT_TIMESTAMP),
  ('INFO_AREA',       'Info area / insert card',true,  NULL, NULL, NULL, 120, true, true, CURRENT_TIMESTAMP),
  ('TOPCARD',         'Top card / header card', true,  NULL, NULL, NULL, 130, true, true, CURRENT_TIMESTAMP),
  ('PICTOGRAM',       'Pictogram sticker',      true,  NULL, NULL, NULL, 140, true, true, CURRENT_TIMESTAMP),
  ('HEAT_TRANSFER',   'Heat transfer',          true,  NULL, NULL, NULL, 150, true, true, CURRENT_TIMESTAMP),
  ('RFID',            'RFID / security label',  true,  NULL, NULL, NULL, 160, true, true, CURRENT_TIMESTAMP),
  -- artwork = false from here down: physical packing instructions with no file
  -- behind them. Their status columns stay NULL and are stripped on read.
  ('POLYBAG',         'Polybag',                false, NULL, NULL, NULL, 170, true, true, CURRENT_TIMESTAMP),
  ('HANGER',          'Hanger',                 false, NULL, NULL, NULL, 180, true, true, CURRENT_TIMESTAMP),
  ('BOX',             'Carton / box / display', false, NULL, NULL, NULL, 190, true, true, CURRENT_TIMESTAMP),
  ('HOOK',            'Hook / string / loop',   false, NULL, NULL, NULL, 200, true, true, CURRENT_TIMESTAMP),
  ('PACKING_NOTE',    'Packing instruction',    false, NULL, NULL, NULL, 210, true, true, CURRENT_TIMESTAMP)
ON CONFLICT ("value") DO NOTHING;

-- Fold in the AppSetting blob this table replaces, so nobody's edited wording is
-- lost and there is exactly one place to edit it afterwards. Production has no
-- such row (the blob never shipped), so on prod this is a no-op; it exists for
-- any environment where the packaging-wording editor was used before this.
--
-- Only concepts that exist as rows are folded. A blob key naming a concept the
-- catalogue never had could only have come from a hand-rolled PUT, and inventing
-- a row for it would put vocabulary nobody chose on the cover.
UPDATE "trim_concept_rows" r
SET "note"            = COALESCE(c."note", r."note"),
    "pendingStatus"   = CASE WHEN r."artwork" THEN COALESCE(c."pending", r."pendingStatus") ELSE r."pendingStatus" END,
    "deliveredStatus" = CASE WHEN r."artwork" THEN COALESCE(c."delivered", r."deliveredStatus") ELSE r."deliveredStatus" END
FROM (
  SELECT e.key                    AS "value",
         e.value->>'note'         AS "note",
         e.value->>'pending'      AS "pending",
         e.value->>'delivered'    AS "delivered"
    FROM "app_settings" s,
         LATERAL jsonb_each(s."value"->'copy') e
   WHERE s."key" = 'trimConceptCopy'
     AND jsonb_typeof(s."value"->'copy') = 'object'
     AND jsonb_typeof(e.value) = 'object'
) c
WHERE r."value" = c."value";

DELETE FROM "app_settings" WHERE "key" = 'trimConceptCopy';
