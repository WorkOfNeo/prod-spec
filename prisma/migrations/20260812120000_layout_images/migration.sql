-- Shared image library for the Output Builder's {{image:<slug>}} token.
-- Unlike output_layouts.custom_logo (one image per layout), these are reused
-- across layouts and a layout may place any number of them.
CREATE TABLE "layout_images" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "image" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "layout_images_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "layout_images_slug_key" ON "layout_images"("slug");

CREATE INDEX "layout_images_active_idx" ON "layout_images"("active");
