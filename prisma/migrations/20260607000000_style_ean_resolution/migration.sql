-- PO → EAN resolution.
--
-- Persists the EANs scraped from a Style's Purchase Order PDF so the result
-- survives across requests and feeds the admin UIs. `styles.eanStatus` is
-- both the durable state and the work queue drained by the EAN runner
-- (/api/po-eans/run): PENDING is set when a PO number is filled, and
-- PO_FOUND_NO_EANS marks "we have the PO but the PDF has no barcode page yet"
-- (retried by the sweep). Per-size EANs live in style_eans; the single
-- carton/assortment EAN lives on styles.cartonEan.

-- CreateEnum
CREATE TYPE "StyleEanStatus" AS ENUM ('NONE', 'PENDING', 'RESOLVING', 'RESOLVED', 'PARTIAL', 'PO_FOUND_NO_EANS', 'PO_NOT_FOUND', 'ERROR');

-- AlterTable
ALTER TABLE "styles" ADD COLUMN     "eanStatus" "StyleEanStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "cartonEan" TEXT,
ADD COLUMN     "poFileName" TEXT,
ADD COLUMN     "eanResolvedAt" TIMESTAMP(3),
ADD COLUMN     "eanResolveStartedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "style_eans" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "size" TEXT NOT NULL,
    "ean13" TEXT,
    "variantLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "style_eans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "styles_eanStatus_idx" ON "styles"("eanStatus");

-- CreateIndex
CREATE INDEX "style_eans_styleId_idx" ON "style_eans"("styleId");

-- CreateIndex
CREATE UNIQUE INDEX "style_eans_styleId_position_key" ON "style_eans"("styleId", "position");

-- AddForeignKey
ALTER TABLE "style_eans" ADD CONSTRAINT "style_eans_styleId_fkey" FOREIGN KEY ("styleId") REFERENCES "styles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
