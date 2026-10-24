import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { orEmpty } from "@/lib/change-requests/db-safe";

export const runtime = "nodejs";

// Stream a screenshot attached to a change request, inline. ADMIN only, like
// every change-request route (the creator check below is for when filing
// opens to reviewers).
// id-addressed + immutable, so it's hard-cached (private — behind the session),
// the same as the rejection-attachment route.
//
//   GET /api/admin/change-requests/<requestId>/attachments/<attachmentId>
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; attachmentId: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { id, attachmentId } = await ctx.params;
  const att = await orEmpty(
    db.changeRequestAttachment.findFirst({
      where: { id: attachmentId, requestId: id },
      select: { data: true, mimeType: true, request: { select: { createdById: true } } },
    }),
    null,
  );
  if (!att) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  if (!isAdmin(role) && att.request.createdById !== session.user.id) {
    return NextResponse.json({ error: "Only an admin or the person who filed this request can see it" }, { status: 403 });
  }

  return new NextResponse(new Uint8Array(att.data), {
    status: 200,
    headers: {
      "Content-Type": att.mimeType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=31536000, immutable",
      // Stored bytes are served as the declared image type, never sniffed.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
