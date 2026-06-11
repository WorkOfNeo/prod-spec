-- Single-use signup invitations (invite-only onboarding).
--
-- invites — one row per invitation. The token rides in the
-- /signup?invite=<token> link; the signup hook (src/lib/auth.ts) requires
-- a live invite for the matching email once the first admin exists, and
-- consumes it (usedAt + usedById) after the user is created. Rows are
-- kept after use as an audit trail of who invited whom.
--
-- EmailType gains INVITE for the invitation email sent through the
-- flag-aware dispatcher (src/lib/email/dispatch.ts).
--
-- Additive + idempotent; existing rows, sessions and users unaffected.

-- AlterEnum
ALTER TYPE "EmailType" ADD VALUE IF NOT EXISTS 'INVITE';

-- CreateTable
CREATE TABLE IF NOT EXISTS "invites" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'REVIEWER',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "invitedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "invites_token_key" ON "invites"("token");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "invites_usedById_key" ON "invites"("usedById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "invites_email_idx" ON "invites"("email");

-- AddForeignKey (guarded — ADD CONSTRAINT has no IF NOT EXISTS)
DO $$ BEGIN
    ALTER TABLE "invites" ADD CONSTRAINT "invites_invitedById_fkey"
        FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey (guarded)
DO $$ BEGIN
    ALTER TABLE "invites" ADD CONSTRAINT "invites_usedById_fkey"
        FOREIGN KEY ("usedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
