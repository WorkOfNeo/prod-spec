import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { runTicketJob, TicketRunError } from "@/lib/tickets/run-ticket-job";
import { dispatchEmail } from "@/lib/email/dispatch";
import { ticketFixedEmail } from "@/lib/email/templates/review-notification";
import { notifyUser } from "@/lib/notifications/user-notifications";
import { getReviewNotificationEmails } from "@/lib/settings/app-settings";

export const runtime = "nodejs";
export const maxDuration = 300;

const STAMP = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

const SCHEMA = z.object({
  // Optional note from the admin — "what I changed" — carried to the reviewer
  // in the re-review notification + email and kept on the ticket. Empty or
  // absent ⇒ no note (the reviewer just hears it's ready for another look).
  comment: z.string().trim().max(500).optional(),
});

// "Mark fixed & notify": final re-run of the ticket's output (TICKET_FIX —
// the generic review-ready email stays quiet), then ticket → FIXED and the
// dedicated "fixed — ready for re-review" email goes to the internal
// reviewer, quoting the original rejection comment and the admin's fix note.
// If the render fails the ticket keeps its status and no email is sent.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });
  }

  const { id } = await ctx.params;

  // The fix note is optional, so an empty/absent body is fine — only reject a
  // body that is present but malformed or oversized.
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = SCHEMA.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const fixNote = parsed.data.comment && parsed.data.comment.length > 0 ? parsed.data.comment : null;

  const ticket = await db.rejectionTicket.findUnique({
    where: { id },
    include: { reportedBy: { select: { name: true, email: true } } },
  });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  if (ticket.status === "RESOLVED" || ticket.status === "FIXED") {
    return NextResponse.json({ error: `Ticket is already ${ticket.status}` }, { status: 400 });
  }

  let run;
  try {
    run = await runTicketJob({ ticket, triggerSource: "TICKET_FIX", userEmail: session.user.email });
  } catch (err) {
    if (err instanceof TicketRunError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
  if (run.jobStatus === "FAILED") {
    return NextResponse.json(
      { error: `Re-run failed — ticket NOT marked fixed: ${run.jobError ?? "see job log"}`, jobId: run.jobId },
      { status: 422 },
    );
  }

  await db.rejectionTicket.update({
    where: { id: ticket.id },
    data: { status: "FIXED", fixedAt: new Date(), fixNote },
  });

  const recipients = await getReviewNotificationEmails();
  const base = process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  const email = ticketFixedEmail({
    outputName: ticket.outputName,
    styleName: ticket.styleName,
    styleNumber: ticket.styleNumber,
    customerName: ticket.customerName,
    businessArea: ticket.businessArea,
    poNumber: ticket.poNumber,
    comment: ticket.comment,
    fixNote,
    rejectedAtLabel: `${STAMP.format(ticket.createdAt)} · ${ticket.reportedBy.name || ticket.reportedBy.email}`,
    reviewUrl: `${base}/styles/${ticket.styleId}/review`,
  });
  const outcome = await dispatchEmail({
    type: "TICKET_FIXED",
    to: recipients,
    subject: email.subject,
    html: email.html,
    text: email.text,
    jobId: run.jobId,
    styleId: ticket.styleId,
    ticketId: ticket.id,
  });
  await db.log.create({
    data: {
      jobId: run.jobId,
      level: outcome.status === "FAILED" ? "WARN" : "INFO",
      message: `ticket ${ticket.id} marked FIXED by ${session.user.email} · re-review notification ${outcome.status} → ${outcome.to || "(no recipient)"}`,
    },
  });

  // In-app mirror for the reporter — they raised the rejection, so the fix
  // lands back on their /dashboard regardless of who the email recipients
  // are, with the admin's note (if any) leading. Fail-soft; auto-resolved
  // when the re-review settles the job.
  const context = [
    ticket.outputName,
    ticket.styleName,
    ticket.customerName,
    ticket.poNumber ? `PO ${ticket.poNumber}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  await notifyUser(ticket.reportedById, {
    type: "TICKET_FIXED",
    title: "Fixed — ready for re-review",
    body: [fixNote, context].filter(Boolean).join(" — "),
    href: `/styles/${ticket.styleId}/review`,
    jobId: run.jobId,
    styleId: ticket.styleId,
    ticketId: ticket.id,
  });

  return NextResponse.json({ ok: true, jobId: run.jobId, latestAsset: run.latestAsset, email: outcome });
}
