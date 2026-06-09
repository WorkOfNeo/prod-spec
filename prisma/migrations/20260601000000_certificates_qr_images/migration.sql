-- Certificate logos (FSC, OEKO-TEX, …) — DB-managed catalogue matched to
-- a Style's certificates list (case-insensitive) and printed on Care
-- Label 02 page 4. Same dual storage convention as wash_symbols.svg.
-- CreateTable
CREATE TABLE "certificates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "certificates_name_key" ON "certificates"("name");

-- CreateIndex
CREATE INDEX "certificates_active_idx" ON "certificates"("active");

-- QR images — uploaded pictures (we don't generate QR codes), linked
-- per Style and rendered as-is on Care Label 02 page 4.
-- CreateTable
CREATE TABLE "qr_images" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "qr_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "qr_images_active_idx" ON "qr_images"("active");

-- A Style links to at most one QR image; SetNull on delete so removing a
-- QR image just drops the link, never the Style.
-- AlterTable
ALTER TABLE "styles" ADD COLUMN "qrImageId" TEXT;

-- CreateIndex
CREATE INDEX "styles_qrImageId_idx" ON "styles"("qrImageId");

-- AddForeignKey
ALTER TABLE "styles" ADD CONSTRAINT "styles_qrImageId_fkey" FOREIGN KEY ("qrImageId") REFERENCES "qr_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;
