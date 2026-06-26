import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { runTicketJob, TicketRunError } from "@/lib/tickets/run-ticket-job";
import { notifyUser } from "@/lib/notifications/user-notifications";

export const runtime = "nodejs";
export const maxDuration = 300;

// "Mark fixed & notify" — flip the ticket to FIXED and drop an in-app re-review
// notice on the reporter's /dashboard. Two modes, chosen by the request body:
//   • { regenerate: true } (default) — final re-run of the output first
//     (TICKET_FIX, the generic review-ready email stays quiet), the original
//     behaviour. If the render fails the ticket keeps its status.
//   • { regenerate: false } — mark fixed WITHOUT re-rendering, for when the
//     output is already up to date (e.g. regenerated since the rejection) and a
//     slow re-render would be wasted work.
// Email is intentionally NOT sent — this is an internal flow today; the email
// path will be wired up later.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });
  }

  // Default to the re-render path so existing callers that send no body (the
  // per-ticket "Mark fixed & notify reviewer" button) behave exactly as before.
  let regenerate = true;
  try {
    const body = (await req.json()) as { regenerate?: unknown };
    if (body?.regenerate === false) regenerate = false;
  } catch {
    // No body — keep the default (regenerate).
  }

  const { id } = await ctx.params;
  const ticket = await db.rejectionTicket.findUnique({ where: { id } });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  if (ticket.status === "RESOLVED" || ticket.status === "FIXED") {
    return NextResponse.json({ error: `Ticket is already ${ticket.status}` }, { status: 400 });
  }

  // Optional re-render. When skipped, the reviewer re-reviews whatever the
  // current latest asset is (the admin has refreshed it some other way).
  let run: Awaited<ReturnType<typeof runTicketJob>> | null = null;
  if (regenerate) {
    try {
      run = await runTicketJob({ ticket, triggerSource: "TICKET_FIX", userEmail: session.user.email });
    } catch (err) {
      if (err instanceof TicketRunError) {
        return NextResponse.json({ error: err.message }, { status: err.httpStatus });
      }
      throw err;
    }
    // The output was removed from the spec — the ticket is already resolved in
    // place (no job, no re-review needed). Report it as a clean resolution.
    if (run.removedOutput) {
      return NextResponse.json({
        ok: true,
        removedOutput: true,
        message: "Output is no longer in the prod spec — ticket resolved; nothing to regenerate.",
      });
    }
    if (run.jobStatus === "FAILED") {
      return NextResponse.json(
        { error: `Re-run failed — ticket NOT marked fixed: ${run.jobError ?? "see job log"}`, jobId: run.jobId },
        { status: 422 },
      );
    }
  }

  await db.rejectionTicket.update({
    where: { id: ticket.id },
    data: { status: "FIXED", fixedAt: new Date() },
  });

  await db.log.create({
    data: {
      jobId: run?.jobId ?? undefined,
      level: "INFO",
      message:
        `ticket ${ticket.id} marked FIXED by ${session.user.email} · reviewer notified in-app ` +
        `(${regenerate ? "output re-rendered" : "no re-render — marked fixed as-is"}; email intentionally not sent — internal flow)`,
    },
  });

  // In-app notification for the reporter — they raised the rejection, the fix
  // lands back on their /dashboard. This is the sole re-review notice today
  // (no email). Fail-soft; auto-resolved when the re-review settles the job.
  await notifyUser(ticket.reportedById, {
    type: "TICKET_FIXED",
    title: "Fixed — ready for re-review",
    body: [ticket.outputName, ticket.styleName, ticket.customerName, ticket.poNumber ? `PO ${ticket.poNumber}` : null]
      .filter(Boolean)
      .join(" · "),
    href: `/styles/${ticket.styleId}/review`,
    jobId: run?.jobId ?? undefined,
    styleId: ticket.styleId,
    ticketId: ticket.id,
  });

  return NextResponse.json({ ok: true, jobId: run?.jobId ?? null, latestAsset: run?.latestAsset ?? null });
}
