
-- AlterTable
ALTER TABLE "wash_symbols" ADD COLUMN     "translations" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "countries" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL,
    "nameTranslations" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mondayValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "countries_code_key" ON "countries"("code");

-- CreateIndex
CREATE INDEX "countries_active_idx" ON "countries"("active");

-- CreateIndex
CREATE INDEX "countries_languageCode_idx" ON "countries"("languageCode");

-- CreateIndex
CREATE INDEX "countries_mondayValue_idx" ON "countries"("mondayValue");

