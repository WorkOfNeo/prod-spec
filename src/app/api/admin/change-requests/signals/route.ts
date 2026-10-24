import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { outputSignals, signalTotals } from "@/lib/change-requests/signals";

export const runtime = "nodejs";

// Learning signals for the change-request agent (design §5.9): one row per
// output plus totals — the same numbers the /requests table and the bench
// show. ADMIN only (it includes agent cost). Behind CHANGE_REQUESTS_ENABLED
// (404 before any auth check when off).
//
// GET ?take=50 (newest outputs first; clamped to 1..200 in signals.ts)
export async function GET(req: NextRequest) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const rawTake = req.nextUrl.searchParams.get("take");
  const take = rawTake === null ? undefined : Number(rawTake);
  if (take !== undefined && !Number.isFinite(take)) {
    return NextResponse.json({ error: "take must be a number" }, { status: 400 });
  }

  const rows = await outputSignals({ take });
  return NextResponse.json({ rows, totals: signalTotals(rows) });
}
