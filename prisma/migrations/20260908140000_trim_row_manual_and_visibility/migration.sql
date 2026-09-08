-- Two per-row decisions on the cover page's packaging rows.
--
-- Both columns are ADDITIVE WITH NEUTRAL DEFAULTS, so applying this migration
-- changes no cover: every existing row comes out "not always manual" and
-- "prints", which is exactly what the code did before the columns existed. The
-- flags only do something once a person ticks one.
--
--   alwaysManual  the buyer supplies this artwork, so the cover line is MANUAL
--                 (and gets an upload zone on the Review tab) even when a
--                 declared output carries the concept. Manual used to be only a
--                 fallback, so adding a layout silently took the upload line
--                 away. Meaningless on an artwork = false row (a polybag has no
--                 file), where it is stripped on write.
--
--   printOnCover  does this kind of packaging print on the cover at all.
--                 NOT "active": an inactive row is retired from the editor's
--                 list and KEEPS PRINTING for values already mapped to it,
--                 which is deliberate. This one is the opposite — the row stays
--                 offered and mappable, and simply never reaches paper.
--                 Turning it off moves the manifest fingerprint of every cover
--                 that carried the line, so those covers rebuild. That is the
--                 intended consequence of a deliberate choice, and the reason
--                 the default is true rather than "tidy".
ALTER TABLE "trim_concept_rows"
  ADD COLUMN "alwaysManual" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "printOnCover" BOOLEAN NOT NULL DEFAULT true;
