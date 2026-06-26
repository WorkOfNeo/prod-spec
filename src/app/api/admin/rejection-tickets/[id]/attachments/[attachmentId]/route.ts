import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

// Stream a stored rejection-comment attachment (image) inline. Only the admin
// rejection log links to these, so it's ADMIN-gated. id-addressed + immutable,
// so it's safe to hard-cache (private — behind the admin session).
//
//   GET /api/admin/rejection-tickets/<ticketId>/attachments/<attachmentId>
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; attachmentId: string }> },
) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id, attachmentId } = await ctx.params;
  const att = await db.rejectionAttachment.findFirst({
    where: { id: attachmentId, ticketId: id },
    select: { data: true, mimeType: true },
  });
  if (!att) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(att.data), {
    status: 200,
    headers: {
      "Content-Type": att.mimeType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
