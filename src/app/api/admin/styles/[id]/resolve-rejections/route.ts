import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { resolveStyleRejections } from "@/lib/tickets/resolve-rejections";
import { dispatchEmail } from "@/lib/email/dispatch";
import { ticketsFixedEmail } from "@/lib/email/templates/review-notification";
import { notifyUser } from "@/lib/notifications/user-notifications";
import { getReviewNotificationEmails } from "@/lib/settings/app-settings";

export const runtime = "nodejs";
// A full-style rerun renders the cover + general info + every output, so give
// it the same headroom as the manual rerun route.
export const maxDuration = 300;

// Style-level "Mark fixed & notify" / "Regenerate all & mark fixed": resolve
// every OPEN/IN_PROGRESS rejection for a style in one go. Re-renders only the
// outputs that are stale (or all of them, with ?regenerateAll), marks the
// re-rendered + already-fresh ones FIXED, leaves awaiting-data ones OPEN,
// resolves orphaned ones in place, then sends ONE batched re-review notice.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });
  }

  const { id } = await ctx.params;

  let regenerateAll = false;
  try {
    const body = (await req.json()) as { regenerateAll?: unknown };
    regenerateAll = body?.regenerateAll === true;
  } catch {
    // No body — smart mode (re-render only stale outputs).
  }

  const style = await db.style.findUnique({
    where: { id },
    select: {
      name: true,
      mondayItemId: true,
      poNumber: true,
      businessArea: true,
      customer: { select: { name: true } },
      businessAreaRef: { select: { name: true } },
    },
  });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  const inflight = await db.job.count({
    where: { styleId: id, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inflight > 0) {
    return NextResponse.json({ error: "A job is already in flight for this style — wait for it to finish" }, { status: 409 });
  }

  const outcome = await resolveStyleRejections({ styleId: id, regenerateAll });

  await db.log.create({
    data: {
      jobId: outcome.jobId ?? undefined,
      level: "INFO",
      message:
        `style-level ${regenerateAll ? "regenerate-all + " : ""}mark-fixed by ${session.user.email} — ` +
        `${outcome.fixed.length} fixed, ${outcome.awaitingData.length} awaiting data, ` +
        `${outcome.resolvedOrphan.length} orphan resolved, ${outcome.failed.length} failed`,
    },
  });

  // ONE batched re-review notice for the whole style (not one per output).
  let email = null;
  if (outcome.fixed.length > 0) {
    const recipients = await getReviewNotificationEmails();
    const base = process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
    const tpl = ticketsFixedEmail({
      styleName: style.name,
      styleNumber: style.mondayItemId,
      customerName: style.customer.name,
      businessArea: style.businessAreaRef?.name ?? style.businessArea,
      poNumber: style.poNumber,
      outputNames: outcome.fixed.map((f) => f.outputName),
      reviewUrl: `${base}/styles/${id}/review`,
    });
    email = await dispatchEmail({
      type: "TICKET_FIXED",
      to: recipients,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
      jobId: outcome.jobId ?? undefined,
      styleId: id,
    });

    // In-app mirror to each reviewer who raised one of the fixed rejections.
    const reporters = [...new Set(outcome.fixed.map((f) => f.reportedById))];
    const body = [style.name, style.customer.name, style.poNumber ? `PO ${style.poNumber}` : null]
      .filter(Boolean)
      .join(" · ");
    await Promise.all(
      reporters.map((uid) =>
        notifyUser(uid, {
          type: "TICKET_FIXED",
          title: `Fixed — ${outcome.fixed.length} output${outcome.fixed.length === 1 ? "" : "s"} ready for re-review`,
          body,
          href: `/styles/${id}/review`,
          jobId: outcome.jobId ?? undefined,
          styleId: id,
        }),
      ),
    );
  }

  return NextResponse.json({ ok: true, ...outcome, email });
}
