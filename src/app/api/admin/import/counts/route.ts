// GET /api/admin/import/counts
//
// Powers the sidebar notification bell. Returns a single combined
// `badge` count + the breakdown so the dashboard can show "N pending
// combinations · M items ready to import" without re-scanning.
//
// The counts are global — the same for every admin — but the scan behind
// them walks every Monday ghost board, and every open admin tab polls this
// once a minute. So the computed result is memoized in-process for 60s (one
// Railway instance), concurrent polls sharing the scan in flight: the badge
// can trail an import or a new combination by up to a minute. Only this
// route is cached — /import, the bell's popover list and bulk accept call
// scanForImport directly and always read fresh. The role check still runs on
// every request.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { scanForImport } from "@/lib/import/scan";
import { findUnconfiguredProdSpecs } from "@/lib/import/prod-specs";
import { ttlMemo } from "@/lib/ttl-memo";

export const runtime = "nodejs";

const COUNTS_TTL_MS = 60_000;

const getCounts = ttlMemo(async () => {
  const [result, unconfigured] = await Promise.all([
    scanForImport(),
    findUnconfiguredProdSpecs(),
  ]);
  const combinations = result.newCombinations.length;
  const importable = result.importable.length;
  const needsConfig = unconfigured.length;
  return {
    badge: combinations + importable + needsConfig,
    parts: {
      combinations,
      importable,
      ambiguous: result.ambiguous.length,
      needsConfig,
    },
  };
}, COUNTS_TTL_MS);

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  return NextResponse.json(await getCounts());
}
