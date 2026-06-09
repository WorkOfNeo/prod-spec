-- CreateTable
CREATE TABLE "wash_symbols" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "svg" TEXT,
    "mondayValue" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wash_symbols_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wash_symbols_code_key" ON "wash_symbols"("code");

-- CreateIndex
CREATE INDEX "wash_symbols_active_idx" ON "wash_symbols"("active");

-- CreateIndex
CREATE INDEX "wash_symbols_mondayValue_idx" ON "wash_symbols"("mondayValue");
