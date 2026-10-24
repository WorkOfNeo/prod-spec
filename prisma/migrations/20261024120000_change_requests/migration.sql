-- Change requests (design docs/plans/change-requests.md §4): layout revision
-- history plus the request / output / attachment / thread / agent-step tables
-- and the agent's memory notes.
--
-- Purely additive (seven new tables, no existing table or row touched),
-- idempotent (IF NOT EXISTS; FKs in DO blocks that swallow duplicate_object) so
-- it is safe to re-run via `prisma migrate deploy` against the live database.
-- Every status / kind column is TEXT validated in code
-- (src/lib/change-requests/types.ts) — no enums here. User references
-- (authorUserId, createdById, publishedById, …) are audit-only scalars with no
-- FK to users, like user_notifications. Every reader of these tables degrades
-- on P2021 (missing table), so pages stay up between merge and deploy, and the
-- whole feature is behind CHANGE_REQUESTS_ENABLED.
--
-- Drafts never change what prints: only publishRevision() writes
-- output_layouts.definition. A revision cascades with its layout.

-- ── Layout revisions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "output_layout_revisions" (
    "id" TEXT NOT NULL,
    "layoutId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "baseDefinition" JSONB NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "authorKind" TEXT NOT NULL,
    "authorUserId" TEXT,
    "changeRequestOutputId" TEXT,
    "parentRevisionId" TEXT,
    "ops" JSONB,
    "note" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "publishedVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "output_layout_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "output_layout_revisions_layoutId_number_key" ON "output_layout_revisions"("layoutId", "number");
CREATE INDEX IF NOT EXISTS "output_layout_revisions_layoutId_status_idx" ON "output_layout_revisions"("layoutId", "status");
CREATE INDEX IF NOT EXISTS "output_layout_revisions_changeRequestOutputId_idx" ON "output_layout_revisions"("changeRequestOutputId");

-- ── Change requests ──────────────────────────────────────────────────────────
-- "number" is the human reference (R-0001): SERIAL, i.e. Prisma's
-- @default(autoincrement()).
CREATE TABLE IF NOT EXISTS "change_requests" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "customerId" TEXT,
    "poNumber" TEXT,
    "styleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "change_requests_number_key" ON "change_requests"("number");
CREATE INDEX IF NOT EXISTS "change_requests_status_createdAt_idx" ON "change_requests"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "change_requests_createdById_idx" ON "change_requests"("createdById");

CREATE TABLE IF NOT EXISTS "change_request_outputs" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL,
    "variantKey" TEXT,
    "layoutId" TEXT,
    "styleId" TEXT,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentRevisionId" TEXT,
    "draftCount" INTEGER NOT NULL DEFAULT 0,
    "awaitingToken" TEXT,
    "codeSpec" JSONB,
    "impact" JSONB,
    "rejectReason" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "firstTryApproved" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "change_request_outputs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "change_request_outputs_requestId_idx" ON "change_request_outputs"("requestId");
CREATE INDEX IF NOT EXISTS "change_request_outputs_status_idx" ON "change_request_outputs"("status");

-- Screenshots — bytes in Postgres, served only behind an admin route (the
-- rejection_attachments pattern).
CREATE TABLE IF NOT EXISTS "change_request_attachments" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "outputId" TEXT,
    "data" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_request_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "change_request_attachments_requestId_idx" ON "change_request_attachments"("requestId");

CREATE TABLE IF NOT EXISTS "change_request_messages" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "outputId" TEXT,
    "authorKind" TEXT NOT NULL,
    "authorUserId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'message',
    "body" TEXT NOT NULL,
    "revisionId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_request_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "change_request_messages_requestId_createdAt_idx" ON "change_request_messages"("requestId", "createdAt");

-- Agent run log: audit trail + cost per step.
CREATE TABLE IF NOT EXISTS "change_request_steps" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "outputId" TEXT,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "model" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "change_request_steps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "change_request_steps_requestId_createdAt_idx" ON "change_request_steps"("requestId", "createdAt");

-- ── Agent memory ─────────────────────────────────────────────────────────────
-- Standalone: sourceRequestId is a loose reference so forgetting a request
-- never deletes what was learned from it.
CREATE TABLE IF NOT EXISTS "agent_memories" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeRef" TEXT,
    "text" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceRequestId" TEXT,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "agent_memories_scope_state_idx" ON "agent_memories"("scope", "state");

-- ── Foreign keys ─────────────────────────────────────────────────────────────
-- All cascade: revisions vanish with their layout; outputs, attachments,
-- thread messages and steps vanish with their request.
DO $$ BEGIN
  ALTER TABLE "output_layout_revisions" ADD CONSTRAINT "output_layout_revisions_layoutId_fkey"
    FOREIGN KEY ("layoutId") REFERENCES "output_layouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "change_request_outputs" ADD CONSTRAINT "change_request_outputs_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "change_request_attachments" ADD CONSTRAINT "change_request_attachments_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "change_request_messages" ADD CONSTRAINT "change_request_messages_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "change_request_steps" ADD CONSTRAINT "change_request_steps_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
