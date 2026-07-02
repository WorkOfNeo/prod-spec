-- Supplier contacts mirrored from the Monday "Supplier Contacts" board
-- (3363269178). One row per contact person; supplierId resolves the
-- board-relation link to the local Supplier mirror. Additive, idempotent
-- (IF NOT EXISTS) so it's safe + re-runnable via `prisma migrate deploy`
-- against the live Railway DB.

ALTER TYPE "SyncKind" ADD VALUE IF NOT EXISTS 'SUPPLIER_CONTACTS';

CREATE TABLE IF NOT EXISTS "supplier_contacts" (
    "id" TEXT NOT NULL,
    "mondayItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "contactType" TEXT,
    "status" TEXT,
    "supplierId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "supplier_contacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "supplier_contacts_mondayItemId_key"
    ON "supplier_contacts" ("mondayItemId");
CREATE INDEX IF NOT EXISTS "supplier_contacts_supplierId_idx"
    ON "supplier_contacts" ("supplierId");
CREATE INDEX IF NOT EXISTS "supplier_contacts_active_idx"
    ON "supplier_contacts" ("active");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'supplier_contacts_supplierId_fkey'
    ) THEN
        ALTER TABLE "supplier_contacts"
            ADD CONSTRAINT "supplier_contacts_supplierId_fkey"
            FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
