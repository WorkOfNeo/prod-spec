-- Translation dictionary — the canonical English→multilang store, sync'd
-- from Monday board 9671510799 ("ALL translations": wash-care phrases,
-- care-label text, "Made in <country>" lines, …). Replaces the hardcoded
-- MADE_IN_PHRASE / COUNTRY_NAMES tables and the careInstructionsByLang
-- stopgap. `translations` follows the same JSON-keyed-by-Language.code
-- convention as wash_symbols.translations / countries.nameTranslations.
-- CreateTable
CREATE TABLE "translations" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sourceText" TEXT NOT NULL,
    "translations" JSONB NOT NULL DEFAULT '{}',
    "category" TEXT,
    "mondayItemId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translations_pkey" PRIMARY KEY ("id")
);

-- `key` is the normalised English phrase — unique so sync is idempotent
-- and renderer lookups are O(1).
-- CreateIndex
CREATE UNIQUE INDEX "translations_key_key" ON "translations"("key");

-- CreateIndex
CREATE INDEX "translations_active_idx" ON "translations"("active");

-- CreateIndex
CREATE INDEX "translations_mondayItemId_idx" ON "translations"("mondayItemId");
