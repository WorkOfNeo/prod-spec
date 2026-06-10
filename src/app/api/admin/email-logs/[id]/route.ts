import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";

export const runtime = "nodejs";

// Single email-log row incl. the HTML body — fetched on demand by the
// email dialog ("View" on /settings/notifications). The body stays out of
// the list payload so the activity table doesn't ship 50 documents.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const row = await db.emailLog.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "Email log not found" }, { status: 404 });

  return NextResponse.json({
    id: row.id,
    type: row.type,
    status: row.status,
    to: row.to,
    cc: row.cc,
    subject: row.subject,
    html: row.html,
    attachments: row.attachments,
    error: row.error,
    jobId: row.jobId,
    styleId: row.styleId,
    ticketId: row.ticketId,
    createdAt: row.createdAt.toISOString(),
  });
}
