-- Per-(style × output × line) reviewer text overrides. Additive: until this
-- migration is deployed the loaders' availability probe returns false and the
-- feature lies dormant (see output-line-values.ts).
CREATE TABLE "style_output_line_values" (
    "id" TEXT NOT NULL,
    "styleId" TEXT NOT NULL,
    "variantKey" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "outputName" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "style_output_line_values_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "style_output_line_values_styleId_variantKey_lineKey_key" ON "style_output_line_values"("styleId", "variantKey", "lineKey");

CREATE INDEX "style_output_line_values_styleId_idx" ON "style_output_line_values"("styleId");
