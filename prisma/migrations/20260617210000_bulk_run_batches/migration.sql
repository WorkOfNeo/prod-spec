-- Progress handle for the admin "Run all outputs" bulk action on /styles: one
-- row per bulk run, holding the stable TOTAL + the enqueued jobIds the /styles
-- page polls to show DONE/TOTAL. Purely additive (new table), idempotent, safe
-- to re-run via `prisma migrate deploy`. No change to the hot "jobs" table — job
-- membership is denormalized as jobIds (JSONB) here, like cron_runs.
CREATE TABLE IF NOT EXISTS "bulk_run_batches" (
  "id"             TEXT NOT NULL,
  "createdById"    TEXT,
  "createdByEmail" TEXT,
  "label"          TEXT NOT NULL,
  "total"          INTEGER NOT NULL DEFAULT 0,
  "styleIds"       JSONB NOT NULL DEFAULT '[]',
  "jobIds"         JSONB NOT NULL DEFAULT '[]',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"     TIMESTAMP(3),

  CONSTRAINT "bulk_run_batches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "bulk_run_batches_createdAt_idx" ON "bulk_run_batches"("createdAt");
