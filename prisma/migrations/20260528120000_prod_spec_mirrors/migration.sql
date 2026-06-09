-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('CUSTOMERS', 'SUPPLIERS', 'BUSINESS_AREAS', 'STYLES', 'ALL');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- AlterEnum
ALTER TYPE "DocType" ADD VALUE 'CARE_LABEL';
ALTER TYPE "DocType" ADD VALUE 'HANGTAG';

-- AlterTable
ALTER TABLE "customers" DROP COLUMN "sharepointPath",
DROP COLUMN "supplierEmail",
ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "location" TEXT,
ADD COLUMN     "mondayItemId" TEXT,
ADD COLUMN     "priority" TEXT,
ADD COLUMN     "salesResponsible" TEXT;

-- AlterTable
ALTER TABLE "styles" ADD COLUMN     "businessAreaId" TEXT,
ADD COLUMN     "poNumber" TEXT,
ADD COLUMN     "prodSpecId" TEXT,
ADD COLUMN     "styleFolderUrl" TEXT,
ADD COLUMN     "supplierId" TEXT;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "mondayItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purchaser" TEXT,
    "address" TEXT,
    "location" TEXT,
    "postCode" TEXT,
    "country" TEXT,
    "sharepointUrl" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_areas" (
    "id" TEXT NOT NULL,
    "mondayValue" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prod_specs" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "businessAreaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "outputs" JSONB NOT NULL DEFAULT '{}',
    "columnMapping" JSONB NOT NULL DEFAULT '{}',
    "requiredFields" JSONB NOT NULL DEFAULT '[]',
    "autoGenerateThresholdPct" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prod_specs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prod_spec_suppliers" (
    "id" TEXT NOT NULL,
    "prodSpecId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prod_spec_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "itemsTotal" INTEGER NOT NULL DEFAULT 0,
    "itemsSynced" INTEGER NOT NULL DEFAULT 0,
    "itemsFailed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_mondayItemId_key" ON "suppliers"("mondayItemId");

-- CreateIndex
CREATE INDEX "suppliers_active_idx" ON "suppliers"("active");

-- CreateIndex
CREATE UNIQUE INDEX "business_areas_mondayValue_key" ON "business_areas"("mondayValue");

-- CreateIndex
CREATE INDEX "business_areas_active_idx" ON "business_areas"("active");

-- CreateIndex
CREATE INDEX "prod_specs_customerId_idx" ON "prod_specs"("customerId");

-- CreateIndex
CREATE INDEX "prod_specs_businessAreaId_idx" ON "prod_specs"("businessAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "prod_specs_customerId_businessAreaId_key" ON "prod_specs"("customerId", "businessAreaId");

-- CreateIndex
CREATE INDEX "prod_spec_suppliers_supplierId_idx" ON "prod_spec_suppliers"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "prod_spec_suppliers_prodSpecId_supplierId_key" ON "prod_spec_suppliers"("prodSpecId", "supplierId");

-- CreateIndex
CREATE INDEX "sync_jobs_kind_idx" ON "sync_jobs"("kind");

-- CreateIndex
CREATE INDEX "sync_jobs_startedAt_idx" ON "sync_jobs"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "customers_mondayItemId_key" ON "customers"("mondayItemId");

-- CreateIndex
CREATE INDEX "customers_active_idx" ON "customers"("active");

-- CreateIndex
CREATE INDEX "styles_businessAreaId_idx" ON "styles"("businessAreaId");

-- CreateIndex
CREATE INDEX "styles_supplierId_idx" ON "styles"("supplierId");

-- CreateIndex
CREATE INDEX "styles_prodSpecId_idx" ON "styles"("prodSpecId");

-- CreateIndex
CREATE INDEX "styles_poNumber_idx" ON "styles"("poNumber");

-- AddForeignKey
ALTER TABLE "prod_specs" ADD CONSTRAINT "prod_specs_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prod_specs" ADD CONSTRAINT "prod_specs_businessAreaId_fkey" FOREIGN KEY ("businessAreaId") REFERENCES "business_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prod_spec_suppliers" ADD CONSTRAINT "prod_spec_suppliers_prodSpecId_fkey" FOREIGN KEY ("prodSpecId") REFERENCES "prod_specs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prod_spec_suppliers" ADD CONSTRAINT "prod_spec_suppliers_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "styles" ADD CONSTRAINT "styles_businessAreaId_fkey" FOREIGN KEY ("businessAreaId") REFERENCES "business_areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "styles" ADD CONSTRAINT "styles_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "styles" ADD CONSTRAINT "styles_prodSpecId_fkey" FOREIGN KEY ("prodSpecId") REFERENCES "prod_specs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
