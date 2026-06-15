-- Add NEW_COMBO value to the EmailType enum.
-- Used by src/lib/combos/reconcile.ts when a new (Customer × Business-Area)
-- combo first appears among active styles — a staged heads-up email to the
-- admin. Kept in its OWN migration (ahead of the combo table) so the new
-- enum value is committed before any row writes it. Additive; existing
-- email_logs rows are unaffected.
ALTER TYPE "EmailType" ADD VALUE IF NOT EXISTS 'NEW_COMBO';
