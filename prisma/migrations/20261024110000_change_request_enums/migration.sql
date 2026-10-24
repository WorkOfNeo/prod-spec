-- Change requests: the only enum values the feature adds (design
-- docs/plans/change-requests.md §4). Every other new status is TEXT validated
-- in code, so later states need no enum migration.
--
--   EmailType.CHANGE_REQUEST_UPDATE     progress email to the requester
--                                       (live / rejected / needs info).
--   EmailType.CHANGE_REQUEST_NEEDS_CODE the change needs a new token: email to
--                                       the developer with the build prompt.
--   TriggerSource.CHANGE_REQUEST        scoped rerun of exactly the documents an
--                                       approved layout change altered. The
--                                       runner re-arms the cover silently
--                                       (notifySupplier: false) for these and
--                                       never regenerates an approved document.
--   TriggerSource.CHANGE_REQUEST_APPROVED
--                                       the explicit second confirmation: the
--                                       changed documents that were already
--                                       approved go back to review. Silent
--                                       cover like CHANGE_REQUEST; the only
--                                       change-request run allowed to
--                                       regenerate approved documents.
--
-- Additive + idempotent (ADD VALUE IF NOT EXISTS, Postgres 12+); kept in its
-- own migration, ahead of the tables, so the values commit before any code or
-- migration USES them (Postgres can't use a new enum value in the same
-- transaction that adds it). Nothing in this file references them.
ALTER TYPE "EmailType" ADD VALUE IF NOT EXISTS 'CHANGE_REQUEST_UPDATE';
ALTER TYPE "EmailType" ADD VALUE IF NOT EXISTS 'CHANGE_REQUEST_NEEDS_CODE';
ALTER TYPE "TriggerSource" ADD VALUE IF NOT EXISTS 'CHANGE_REQUEST';
ALTER TYPE "TriggerSource" ADD VALUE IF NOT EXISTS 'CHANGE_REQUEST_APPROVED';
