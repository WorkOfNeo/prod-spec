import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { searchOrders } from "@/lib/change-requests/requests";

export const runtime = "nodejs";

// The /requests/new search box: GET ?q= → matching POs (with customer and style
// count) and styles (by Monday item id, name or PO), active styles only.
// Read-only. Same gate as filing a request: flag (404), session (401),
// ADMIN (403).
export async function GET(req: NextRequest) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const result = await searchOrders(req.nextUrl.searchParams.get("q") ?? "");
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
