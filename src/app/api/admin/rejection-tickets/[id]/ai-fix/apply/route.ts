import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { runTicketJob, TicketRunError } from "@/lib/tickets/run-ticket-job";
import { LayoutDefSchema } from "@/lib/output-layouts/schema";
import { layoutIdFromVariantKey } from "@/lib/output-layouts/variant-keys";
import { applyAiFixDefinition, fixKindForVariantKey, AiFixError } from "@/lib/rejection-ai/ai-fix";
import { applyGeneralInfoFix, resolveTicketProdSpecId } from "@/lib/rejection-ai/general-info-fix";

export const runtime = "nodejs";
export const maxDuration = 300;

// Keep the accepted AI proposal. Saves it to its source (exactly like a manual
// edit) then silently re-runs the ticket's output so the fixed PDF regenerates.
// Two kinds, dispatched by the ticket's output:
//   • layout        → { definition } written to the OutputLayout
//   • general-info  → { markdown } written to ProdSpec.generalInfoMd
// The ticket STATUS is left alone — the admin still marks it fixed & notifies
// from the workbench. ADMIN only.
const LAYOUT_BODY = z.object({ definition: LayoutDefSchema });
const GI_BODY = z.object({ markdown: z.string().max(100000) });

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

  const ticket = await db.rejectionTicket.findUnique({ where: { id } });
  if (!ticket) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  const kind = fixKindForVariantKey(ticket.variantKey);

  // Save the edit (the durable action) based on the output kind. If the re-run
  // below can't run right now, the saved change still stands.
  if (kind === "layout") {
    const parsed = LAYOUT_BODY.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid layout definition", details: parsed.error.flatten() }, { status: 400 });
    }
    const layoutId = layoutIdFromVariantKey(ticket.variantKey);
    if (!layoutId) return NextResponse.json({ error: "This output isn't an Output Builder layout." }, { status: 400 });
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
  } else if (kind === "general-info") {
    const parsed = GI_BODY.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid general information markdown" }, { status: 400 });
    }
    let prodSpecId: string;
    try {
      prodSpecId = await resolveTicketProdSpecId(ticket);
    } catch (err) {
      if (err instanceof AiFixError) return NextResponse.json({ error: err.message }, { status: err.httpStatus });
      throw err;
    }
    await applyGeneralInfoFix(prodSpecId, parsed.data.markdown);
    await db.log.create({
      data: {
        level: "INFO",
        message: `AI fix applied to general information of prod spec ${prodSpecId} (from rejection ticket ${ticket.id}) by ${session.user.email}`,
      },
    });
  } else {
    return NextResponse.json({ error: "This output isn't AI-editable." }, { status: 400 });
  }

  // Best-effort silent re-run so the reviewer sees the fixed output. A job in
  // flight (409) doesn't undo the save — report it so the admin re-runs later.
  // General-info re-runs fall through to a full regen (the runner refreshes the
  // cover/general-info page on any full run).
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
