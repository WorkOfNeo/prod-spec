// GET /api/admin/import/counts
//
// Powers the sidebar notification bell. Returns a single combined
// `badge` count + the breakdown so the dashboard can show "N pending
// combinations · M items ready to import" without re-scanning.
//
// Cheap enough (low-thousands of ghost rows scanned in-process under
// half a second) that we don't cache. The bell polls every 60s.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { scanForImport } from "@/lib/import/scan";
import { findUnconfiguredProdSpecs } from "@/lib/import/prod-specs";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [result, unconfigured] = await Promise.all([
    scanForImport(),
    findUnconfiguredProdSpecs(),
  ]);
  const combinations = result.newCombinations.length;
  const importable = result.importable.length;
  const needsConfig = unconfigured.length;
  return NextResponse.json({
    badge: combinations + importable + needsConfig,
    parts: {
      combinations,
      importable,
      ambiguous: result.ambiguous.length,
      needsConfig,
    },
  });
}
