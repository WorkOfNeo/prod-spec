-- Output Builder: operator-built print layouts (corner-anchored text blocks +
-- {{token}} variables, rendered by renderLayoutHtml). Purely additive — a new
-- table + enum, no existing rows touched — so this applies cleanly to the
-- already-live database via `prisma migrate deploy`. Written idempotently to
-- match the repo convention.

DO $$ BEGIN
  CREATE TYPE "OutputLayoutStatus" AS ENUM ('DRAFT', 'PUBLISHED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "output_layouts" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "docType" "DocType" NOT NULL DEFAULT 'STICKER',
  "definition" JSONB NOT NULL DEFAULT '{}',
  "status" "OutputLayoutStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 0,
  "customerId" TEXT,
  "businessAreaId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "output_layouts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "output_layouts_status_idx" ON "output_layouts"("status");
CREATE INDEX IF NOT EXISTS "output_layouts_customerId_idx" ON "output_layouts"("customerId");

DO $$ BEGIN
  ALTER TABLE "output_layouts" ADD CONSTRAINT "output_layouts_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "output_layouts" ADD CONSTRAINT "output_layouts_businessAreaId_fkey"
    FOREIGN KEY ("businessAreaId") REFERENCES "business_areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
