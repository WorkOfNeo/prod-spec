-- Add PASSWORD_RESET to the EmailType enum. Written by the sendResetPassword
-- hook in src/lib/auth.ts, for both the self-service /forgot-password flow and
-- the admin "Send reset link" button on /users — so reset emails show up in the
-- activity table on /settings/notifications like every other outbound email.
--
-- Additive + idempotent (ADD VALUE IF NOT EXISTS, Postgres 12+); safe to re-run
-- via `prisma migrate deploy`.
ALTER TYPE "EmailType" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET';
