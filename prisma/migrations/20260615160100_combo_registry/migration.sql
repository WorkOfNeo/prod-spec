-- Customer × Business-Area combo registry — the admin dashboard at /combos
-- plus its newcomer alerts. One row per distinct (customer, business area)
-- pair ever seen among ACTIVE styles (same set as /styles). Reconciled by
-- src/lib/combos/reconcile.ts on every style sync + the detect-combos cron.
--
-- baKey is a non-null discriminator (resolved BA id / "freetext:<norm>" /
-- "none") so the (customerId, baKey) unique index is reliable — a plain
-- nullable businessAreaId would hit the SQL NULL-uniqueness trap. Rows are
-- kept as history (activeStyleCount → 0) and notifiedAt is stamped once,
-- so a combo is never re-alerted. Additive — no existing table touched.

-- CreateEnum
CREATE TYPE "ComboStatus" AS ENUM ('NEW', 'REVIEWED');

-- CreateTable
CREATE TABLE "customer_business_area_combos" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "businessAreaId" TEXT,
    "baKey" TEXT NOT NULL,
    "baLabel" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "status" "ComboStatus" NOT NULL DEFAULT 'NEW',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "activeStyleCount" INTEGER NOT NULL DEFAULT 0,
    "exampleStyleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_business_area_combos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_business_area_combos_customerId_baKey_key" ON "customer_business_area_combos"("customerId", "baKey");

-- CreateIndex
CREATE INDEX "customer_business_area_combos_status_idx" ON "customer_business_area_combos"("status");

-- CreateIndex
CREATE INDEX "customer_business_area_combos_notifiedAt_idx" ON "customer_business_area_combos"("notifiedAt");

-- CreateIndex
CREATE INDEX "customer_business_area_combos_customerId_idx" ON "customer_business_area_combos"("customerId");

-- CreateIndex
CREATE INDEX "customer_business_area_combos_businessAreaId_idx" ON "customer_business_area_combos"("businessAreaId");

-- AddForeignKey
ALTER TABLE "customer_business_area_combos" ADD CONSTRAINT "customer_business_area_combos_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_business_area_combos" ADD CONSTRAINT "customer_business_area_combos_businessAreaId_fkey" FOREIGN KEY ("businessAreaId") REFERENCES "business_areas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
