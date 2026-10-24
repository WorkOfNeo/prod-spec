import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { approveOutput } from "@/lib/change-requests/publish";
import { publishErrorResponse } from "@/lib/change-requests/publish-errors";

export const runtime = "nodejs";
// Publish, then a fresh impact (two renders per style that prints the
// layout), the rerun enqueue and the requester's before/after.
export const maxDuration = 180;

// =====================================================
// POST /api/admin/change-request-outputs/[id]/approve — approve the output's
// current draft: publish it, rerun exactly the changed documents that are
// not approved and not in flight, mark the output live (publish.ts).
//
//   { force?: boolean }   publish over a conflict (the layout moved since the
//                         draft was made) — only after the admin saw it
//
// 200 with what happened (published version, reruns, approved and delivered
// documents that changed). 409 { error, conflict? } when the draft was
// replaced or the layout moved, 422 { error, details } when the draft fails
// the publish gate. ADMIN only (design §2, rail 2); 404 while
// CHANGE_REQUESTS_ENABLED is off.
// =====================================================

const BodySchema = z.object({ force: z.boolean().optional() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { id } = await ctx.params;
  // An empty POST is a plain approve.
  const parsed = BodySchema.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.issues.map((i) => i.message) }, { status: 400 });
  }

  try {
    const result = await approveOutput(id, {
      userId: session.user.id,
      userEmail: session.user.email ?? null,
      force: parsed.data.force === true,
    });
    return NextResponse.json(result);
  } catch (err) {
    const mapped = publishErrorResponse(err);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    throw err;
  }
}
