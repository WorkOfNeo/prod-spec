import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { loadRequestView } from "@/lib/change-requests/review-view";

export const runtime = "nodejs";

// =====================================================
// GET /api/admin/change-requests/[id] — one request as the review screen
// shows it (review-view.ts): outputs with their draft history, the thread,
// the run log. The /requests/[id] page polls this every few seconds while the
// agent works, so it is the same view the page rendered first.
//
// ADMIN, or the REVIEWER who filed the request — who gets the requester's
// view (no drafts, impact, run log or cost). 404 for everyone while
// CHANGE_REQUESTS_ENABLED is off.
// =====================================================

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });

  const { id } = await ctx.params;
  const result = await loadRequestView(id, { userId: session.user.id, role });
  if (!result.ok) {
    return result.reason === "not_found"
      ? NextResponse.json({ error: "Change request not found" }, { status: 404 })
      : NextResponse.json({ error: "Only an admin or the person who filed this request can see it" }, { status: 403 });
  }
  return NextResponse.json(result.view, { headers: { "cache-control": "no-store" } });
}
