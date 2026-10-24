import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { rejectOutput } from "@/lib/change-requests/publish";
import { REJECT_REASON_MAX, publishErrorResponse } from "@/lib/change-requests/publish-errors";

export const runtime = "nodejs";

// =====================================================
// POST /api/admin/change-request-outputs/[id]/reject — no change for this
// output: its open drafts are discarded, the output is REJECTED with the
// reason, and the requester is told why (publish.ts).
//
//   { reason }   1..500 characters, required
//
// ADMIN only; 404 while CHANGE_REQUESTS_ENABLED is off.
// =====================================================

const BodySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Say why the change is rejected")
    .max(REJECT_REASON_MAX, `Keep the reason under ${REJECT_REASON_MAX} characters`),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { id } = await ctx.params;
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }

  try {
    const result = await rejectOutput(id, { userId: session.user.id, reason: parsed.data.reason });
    return NextResponse.json(result);
  } catch (err) {
    const mapped = publishErrorResponse(err);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    throw err;
  }
}
