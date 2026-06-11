import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { dispatchEmail } from "@/lib/email/dispatch";

export const runtime = "nodejs";

// Manual real-send of a logged email — the "Send for real" action in the
// email dialog. Takes a recipient (and optional sender) override and
// pushes the exact logged body through Resend with force=true, bypassing
// the RESEND_EMAILS gate for this one email so the full delivery path can
// be tested while the flag stays off. The attempt is logged as a NEW
// email_logs row; the original simulated/skipped row stays untouched.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { to, from } = (body ?? {}) as { to?: unknown; from?: unknown };
  if (typeof to !== "string" || !/^\S+@\S+\.\S+$/.test(to.trim())) {
    return NextResponse.json({ error: "Enter a valid recipient email" }, { status: 400 });
  }
  if (from !== undefined && typeof from !== "string") {
    return NextResponse.json({ error: "from must be a string" }, { status: 400 });
  }

  const log = await db.emailLog.findUnique({ where: { id } });
  if (!log) return NextResponse.json({ error: "Email log not found" }, { status: 404 });

  // Attachment BYTES are never persisted (only { filename, bytes } meta),
  // so an email that carried files can't be faithfully re-sent from here.
  const attachments = Array.isArray(log.attachments) ? log.attachments : [];
  if (attachments.length > 0) {
    return NextResponse.json(
      {
        error:
          "This email had attachments, which aren't stored — re-send it from its original trigger instead.",
      },
      { status: 409 },
    );
  }

  const outcome = await dispatchEmail({
    type: log.type,
    to: to.trim(),
    from: typeof from === "string" && from.trim() ? from.trim() : undefined,
    subject: log.subject,
    html: log.html,
    text: log.text ?? undefined,
    jobId: log.jobId,
    styleId: log.styleId,
    ticketId: log.ticketId,
    force: true,
  });

  await db.log.create({
    data: {
      level: outcome.status === "FAILED" ? "WARN" : "INFO",
      jobId: log.jobId,
      message: `manual real-send of email_log ${log.id} (${log.type}, originally ${log.status} to "${log.to || "—"}") to "${outcome.to}" from "${outcome.from}" by user ${auth.userId} — ${outcome.status}`,
    },
  });

  return NextResponse.json({ ok: outcome.status === "SENT", email: outcome });
}
