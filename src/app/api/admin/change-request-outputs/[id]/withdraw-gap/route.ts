import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { withdrawCodeGap } from "@/lib/change-requests/gap";
import { publishErrorResponse } from "@/lib/change-requests/publish-errors";
import { startChangeRequestRun } from "@/lib/change-requests/agent/job";

export const runtime = "nodejs";

// =====================================================
// POST /api/admin/change-request-outputs/[id]/withdraw-gap — "Not a code gap":
// the agent handed this output to the developer, and an admin says it was
// wrong (the value already exists, or the fix is a setting). The hand-off
// (awaited token + code spec) is cleared, the admin's note goes in the thread
// with a status line, and the agent starts again on the thread (gap.ts).
//
//   { note? }   up to 5000 characters: what to use instead
//
// 200 { tokenKey, started, reason? }. 409 unless the output is NEEDS_CODE.
// ADMIN only; 404 while CHANGE_REQUESTS_ENABLED is off.
// =====================================================

const BodySchema = z.object({
  note: z.string().trim().max(5000, "Keep the note under 5000 characters").optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { id } = await ctx.params;
  // The body is optional: an empty POST withdraws without a note.
  const raw = await req.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }

  const userId = session.user.id;
  try {
    const result = await withdrawCodeGap(id, { userId, note: parsed.data.note ?? null }, (outputId) =>
      startChangeRequestRun(outputId, { trigger: "comment", userId }),
    );
    return NextResponse.json(result);
  } catch (err) {
    const mapped = publishErrorResponse(err);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    throw err;
  }
}
