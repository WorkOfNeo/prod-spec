import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { outputsForStyle } from "@/lib/change-requests/requests";

export const runtime = "nodejs";

// The /requests/new output picker: GET ?styleId= → the style's enabled outputs
// ({ variantKey, label, widthMm, heightMm, isLayout }). The thumbnails
// themselves come from the style output-preview route. Read-only; same gate as
// filing a request: flag (404), session (401), ADMIN (403).
export async function GET(req: NextRequest) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const styleId = req.nextUrl.searchParams.get("styleId")?.trim();
  if (!styleId) return NextResponse.json({ error: "styleId is required" }, { status: 400 });

  const outputs = await outputsForStyle(styleId);
  if (!outputs) return NextResponse.json({ error: "Style not found" }, { status: 404 });
  return NextResponse.json({ outputs }, { headers: { "Cache-Control": "no-store" } });
}
