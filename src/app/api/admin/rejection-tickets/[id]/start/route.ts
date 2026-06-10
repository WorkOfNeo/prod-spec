import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";

export const runtime = "nodejs";

// "Start work" on a rejection ticket: OPEN → IN_PROGRESS. Idempotent —
// pressing it on a ticket that's already in progress is a no-op.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const ticket = await db.rejectionTicket.findUnique({ where: { id } });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  if (ticket.status === "IN_PROGRESS") return NextResponse.json({ ok: true, status: ticket.status });
  if (ticket.status !== "OPEN") {
    return NextResponse.json(
      { error: `Cannot start work on a ${ticket.status} ticket` },
      { status: 400 },
    );
  }

  await db.rejectionTicket.update({
    where: { id },
    data: { status: "IN_PROGRESS", startedAt: new Date() },
  });
  await db.log.create({
    data: {
      jobId: ticket.jobId,
      level: "INFO",
      message: `rejection ticket ${ticket.id} (${ticket.outputName}) picked up by ${session.user.email}`,
    },
  });

  return NextResponse.json({ ok: true, status: "IN_PROGRESS" });
}
