-- "Pull style by PO" (Settings) — a manual pin so a historical style can be
-- pulled into the styleboard for layout testing and stay visible regardless of
-- its Monday group (Templates/Done are otherwise hidden by activeStylesWhere).
-- Purely additive nullable column + index. IF NOT EXISTS keeps the deploy
-- idempotent against the live Railway DB and safe to re-run via migrate deploy.
ALTER TABLE "styles" ADD COLUMN IF NOT EXISTS "pulledForTestAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "styles_pulledForTestAt_idx" ON "styles"("pulledForTestAt");
