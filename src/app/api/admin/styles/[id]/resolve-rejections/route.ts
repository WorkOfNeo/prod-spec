import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { resolveStyleRejections } from "@/lib/tickets/resolve-rejections";
import { notifyUser } from "@/lib/notifications/user-notifications";

export const runtime = "nodejs";
// A full-style rerun renders the cover + general info + every output, so give
// it the same headroom as the manual rerun route.
export const maxDuration = 300;

// Style-level "Mark fixed & notify" / "Regenerate all & mark fixed": resolve
// every OPEN/IN_PROGRESS rejection for a style in one go. Re-renders only the
// outputs that are stale (or all of them, with ?regenerateAll), marks the
// re-rendered + already-fresh ones FIXED, leaves awaiting-data ones OPEN,
// resolves orphaned ones in place, then posts ONE batched in-app re-review
// notice. Email is intentionally NOT sent — internal flow, wired up later.
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
      poNumber: true,
      customer: { select: { name: true } },
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
        `${outcome.resolvedOrphan.length} orphan resolved, ${outcome.resolvedExcluded.length} excluded resolved, ` +
        `${outcome.failed.length} failed`,
    },
  });

  // ONE batched in-app re-review notice per reviewer who raised a fixed
  // rejection (not one per output). No email — this is an internal flow today;
  // the email path will be wired up later.
  if (outcome.fixed.length > 0) {
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

  return NextResponse.json({ ok: true, ...outcome });
}
