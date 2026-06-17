-- Automation activity log: one row per cron tick (or "Run now") that drained
-- the EAN queue or the generation queue. Powers the /automation page. Purely
-- additive (new table), idempotent, safe to re-run via `prisma migrate deploy`.
CREATE TABLE IF NOT EXISTS "cron_runs" (
  "id"         TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "source"     TEXT NOT NULL,
  "skipped"    BOOLEAN NOT NULL DEFAULT false,
  "note"       TEXT,
  "processed"  INTEGER NOT NULL DEFAULT 0,
  "failed"     INTEGER NOT NULL DEFAULT 0,
  "requeued"   INTEGER NOT NULL DEFAULT 0,
  "enqueued"   INTEGER NOT NULL DEFAULT 0,
  "styleIds"   JSONB NOT NULL DEFAULT '[]',
  "jobIds"     JSONB NOT NULL DEFAULT '[]',
  "durationMs" INTEGER,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "cron_runs_createdAt_idx" ON "cron_runs"("createdAt");
CREATE INDEX IF NOT EXISTS "cron_runs_kind_createdAt_idx" ON "cron_runs"("kind", "createdAt");
