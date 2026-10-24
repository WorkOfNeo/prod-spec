import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { rerunApprovedDocuments } from "@/lib/change-requests/publish";
import { publishErrorResponse } from "@/lib/change-requests/publish-errors";

export const runtime = "nodejs";
// Recomputes the impact (two renders per style) before enqueueing.
export const maxDuration = 120;

// =====================================================
// POST /api/admin/change-request-outputs/[id]/rerun-approved — the explicit
// second confirmation (design §2, rail 3): changed documents that were
// already approved go back to review after a change is live. Delivery to a
// supplier still only happens when someone approves them again.
//
//   { styleIds? }   only these styles; every approved changed document when
//                   absent
//
// ADMIN only; 404 while CHANGE_REQUESTS_ENABLED is off.
// =====================================================

const BodySchema = z.object({
  styleIds: z.array(z.string().trim().min(1).max(200)).min(1).max(1000).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { id } = await ctx.params;
  const parsed = BodySchema.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }

  try {
    const result = await rerunApprovedDocuments(id, {
      userId: session.user.id,
      userEmail: session.user.email ?? null,
      styleIds: parsed.data.styleIds ?? null,
    });
    return NextResponse.json(result);
  } catch (err) {
    const mapped = publishErrorResponse(err);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    throw err;
  }
}
