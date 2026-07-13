-- Editable AI system prompts, keyed by a stable slug (e.g. "rejection-fix").
-- A row OVERRIDES the built-in code default for that key; no row = the default
-- is used. Admin-edited under Settings → Prompts. Additive, idempotent
-- (IF NOT EXISTS) so it's safe + re-runnable via `prisma migrate deploy`
-- against the live Railway DB.
CREATE TABLE IF NOT EXISTS "system_prompts" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updatedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "system_prompts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "system_prompts_key_key"
    ON "system_prompts" ("key");
