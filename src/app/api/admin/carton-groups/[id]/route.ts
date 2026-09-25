import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { removeCartonGroup } from "@/lib/carton-groups/groups";

export const runtime = "nodejs";

// Remove a multi-style carton group (SOFT delete — see removeCartonGroup).
//
// The response carries `wasUploaded` and `fileName` so the UI can tell the
// reviewer, by name, which file they must go and delete from SharePoint by hand.
// We never delete supplier files, and we never email the supplier about it.
//
//   DELETE /api/admin/carton-groups/<id>  body { reason }
//     → { ok, fileName, wasUploaded, folderUrl }
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  const { id } = await ctx.params;

  let reason = "";
  try {
    const body = (await req.json()) as { reason?: unknown };
    if (typeof body?.reason === "string") reason = body.reason;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const result = await removeCartonGroup({ groupId: id, reason, userId: session.user.id });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(result);
}
