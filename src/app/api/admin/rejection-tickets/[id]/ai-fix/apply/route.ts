import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { runTicketJob, TicketRunError } from "@/lib/tickets/run-ticket-job";
import { LayoutDefSchema } from "@/lib/output-layouts/schema";
import { layoutIdFromVariantKey } from "@/lib/output-layouts/variant-keys";
import { applyAiFixDefinition } from "@/lib/rejection-ai/ai-fix";

export const runtime = "nodejs";
export const maxDuration = 300;

// Keep the accepted AI-proposed definition. Persists it to the ticket's layout
// (exactly like a manual editor save) and then silently re-runs the ticket's
// output so the fresh PDF regenerates. The ticket's STATUS is intentionally
// left alone — the admin still marks it fixed & notifies from the workbench
// (per the agreed "save + re-run, leave the ticket to me" flow). ADMIN only.
const BODY = z.object({ definition: LayoutDefSchema });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { id } = await ctx.params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid layout definition", details: parsed.error.flatten() }, { status: 400 });
  }

  const ticket = await db.rejectionTicket.findUnique({ where: { id } });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  // Derive the layout from the ticket server-side — never trust a client-sent id.
  const layoutId = layoutIdFromVariantKey(ticket.variantKey);
  if (!layoutId) {
    return NextResponse.json({ error: "This output isn't an Output Builder layout." }, { status: 400 });
  }

  // Save the edit (validated). This is the durable action — if the re-run
  // below can't run right now, the layout change still stands.
  try {
    await applyAiFixDefinition(layoutId, parsed.data.definition);
  } catch {
    return NextResponse.json({ error: "Couldn't save the layout — it may have been deleted." }, { status: 404 });
  }

  await db.log.create({
    data: {
      level: "INFO",
      message: `AI fix applied to layout ${layoutId} (from rejection ticket ${ticket.id}) by ${session.user.email}`,
    },
  });

  // Best-effort silent re-run so the reviewer sees the fixed output. A job in
  // flight (409) doesn't undo the save — report it so the admin re-runs later.
  try {
    const run = await runTicketJob({ ticket, triggerSource: "TICKET_RERUN", userEmail: session.user.email });
    if (run.removedOutput) {
      return NextResponse.json({ ok: true, applied: true, rerun: false, removedOutput: true });
    }
    return NextResponse.json({
      ok: true,
      applied: true,
      rerun: true,
      jobId: run.jobId,
      jobStatus: run.jobStatus,
      latestAsset: run.latestAsset,
    });
  } catch (err) {
    if (err instanceof TicketRunError) {
      return NextResponse.json({ ok: true, applied: true, rerun: false, rerunError: err.message });
    }
    throw err;
  }
}
