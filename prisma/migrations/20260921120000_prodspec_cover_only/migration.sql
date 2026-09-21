-- A ProdSpec that produces the cover page and nothing else.
--
-- Additive, DEFAULT false, so every existing spec keeps the behaviour it has:
-- an empty Outputs list still fails with NO_OUTPUTS, because for every spec
-- that has not opted in, empty really does mean somebody forgot.
ALTER TABLE "prod_specs" ADD COLUMN IF NOT EXISTS "coverOnly" BOOLEAN NOT NULL DEFAULT false;
