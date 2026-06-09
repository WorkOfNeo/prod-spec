-- Capture the Monday group (e.g. "✅ Done" / "⏰ Behind Schedule") on
-- each Style so list views can default-hide archived items. groupId is
-- Monday's stable id, groupTitle is the human label (lives on the
-- group, may change without invalidating linkage).
ALTER TABLE "styles" ADD COLUMN "groupId" TEXT;
ALTER TABLE "styles" ADD COLUMN "groupTitle" TEXT;

CREATE INDEX "styles_groupTitle_idx" ON "styles"("groupTitle");

-- Backfill from the ghost mirror. The Styles board's ghost already
-- captures groupId + groupTitle on every item; we just lift them onto
-- existing Style rows so the "Show archived" filter works immediately
-- on the next page load without needing a re-Fill.
UPDATE "styles" s
SET "groupId" = g."groupId",
    "groupTitle" = g."groupTitle"
FROM "monday_ghost_items" g
JOIN "monday_ghost_boards" b ON b.id = g."boardId"
WHERE s."mondayItemId" = g."mondayItemId"
  AND b."mondayBoardId" = '6979419195'
  AND s."groupId" IS NULL;
