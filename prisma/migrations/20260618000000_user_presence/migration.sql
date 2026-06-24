-- User presence — one row per user, refreshed by the admin-layout client
-- heartbeat. `lastSeenAt` drives "online now" / "last online" / online count on
-- the /admin Users tab. Purely additive (new table only, no change to "users"),
-- idempotent, safe to re-run via `prisma migrate deploy`.

CREATE TABLE IF NOT EXISTS "user_presence" (
  "userId"     TEXT NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_presence_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX IF NOT EXISTS "user_presence_lastSeenAt_idx" ON "user_presence"("lastSeenAt");

-- FK with cascade — presence vanishes when the user is deleted.
DO $$ BEGIN
  ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
