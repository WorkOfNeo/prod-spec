import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { runTicketJob, TicketRunError } from "@/lib/tickets/run-ticket-job";

export const runtime = "nodejs";
// Rendering on a cold Puppeteer can take a while.
export const maxDuration = 300;

// Silent iteration re-run: regenerate the ticket's output WITHOUT pinging
// the reviewer (TICKET_RERUN suppresses the review-ready email). The admin
// inspects the fresh preview on the workbench and either iterates again or
// presses "Mark fixed & notify".
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const ticket = await db.rejectionTicket.findUnique({ where: { id } });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  if (ticket.status === "RESOLVED") {
    return NextResponse.json({ error: "Ticket is already resolved" }, { status: 400 });
  }

  try {
    const result = await runTicketJob({
      ticket,
      triggerSource: "TICKET_RERUN",
      userEmail: session.user.email,
    });
    if (result.jobStatus === "FAILED") {
      return NextResponse.json(
        { error: `Re-run failed: ${result.jobError ?? "see job log"}`, jobId: result.jobId },
        { status: 422 },
      );
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof TicketRunError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}
