-- Care-label "actions" — symbol-driven removal/rewrite of care instructions.
--
-- Each wash-care symbol gets a laundering `action` and a `restrictive` flag
-- (a "Do not …" prohibition); each care-instruction line gets an `action`.
-- A present restrictive symbol removes every active CareLabel tagged with the
-- same action on care-label-02 — "prohibition symbols always override extra
-- care instructions". Replaces the dormant, never-wired wash_symbols.
-- "suppressesCareClauses" column. Logic: src/lib/care-labels/visibility.ts.

-- CreateEnum
CREATE TYPE "LaunderingAction" AS ENUM ('WASHING', 'BLEACHING', 'TUMBLE_DRYING', 'IRONING', 'DRY_CLEANING');

-- AlterTable — wash symbols carry their action + prohibition flag.
ALTER TABLE "wash_symbols" ADD COLUMN "action" "LaunderingAction";
ALTER TABLE "wash_symbols" ADD COLUMN "restrictive" BOOLEAN NOT NULL DEFAULT false;
-- Drop the dormant, superseded clause-suppression column (never read/written
-- by app code; the action model replaces it).
ALTER TABLE "wash_symbols" DROP COLUMN "suppressesCareClauses";

-- AlterTable — care lines carry the action their text is about.
ALTER TABLE "care_labels" ADD COLUMN "action" "LaunderingAction";

-- Backfill the standard ISO 3758 / GINETEX symbol set (idempotent: keyed by
-- the stable `code`). New installs seed these via the admin "Seed" action,
-- which sets the same values; this catches catalogues already seeded.
UPDATE "wash_symbols" SET "action" = 'WASHING'       WHERE "code" IN ('wash30', 'wash40', 'wash60', 'wash_hand', 'wash_no');
UPDATE "wash_symbols" SET "action" = 'BLEACHING'     WHERE "code" IN ('bleach_no', 'bleach_oxygen');
UPDATE "wash_symbols" SET "action" = 'TUMBLE_DRYING' WHERE "code" IN ('tumble_low', 'tumble_normal', 'tumble_no');
UPDATE "wash_symbols" SET "action" = 'IRONING'       WHERE "code" IN ('iron_low', 'iron_medium', 'iron_high', 'iron_no');
UPDATE "wash_symbols" SET "action" = 'DRY_CLEANING'  WHERE "code" IN ('dryclean', 'dryclean_no');
-- Prohibition ("Do not …") symbols.
UPDATE "wash_symbols" SET "restrictive" = true WHERE "code" IN ('wash_no', 'bleach_no', 'tumble_no', 'iron_no', 'dryclean_no');

-- Backfill the standard care lines that already exist (matched case-insensitively
-- on the English source text). The compound "wash and iron inside out" line is
-- left untouched here — the admin "Seed standard set" action splits it into
-- atomic "wash inside out" (WASHING) + "iron inside out" (IRONING) lines and
-- retires the compound, so cuid generation stays in app code.
UPDATE "care_labels" SET "action" = 'WASHING'
  WHERE lower("sourceText") IN ('wash with similar colours', 'wash before wearing', 'wash inside out');
UPDATE "care_labels" SET "action" = 'IRONING'
  WHERE lower("sourceText") = 'iron inside out';
