import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { enqueueBulkRun } from "@/lib/queue/bulk-run";
import { computeProdSpecRerunPlan } from "@/lib/outputs/prod-spec-rerun";

export const runtime = "nodejs";
// Enqueue-only — the jobs render in the background (runner cron). Bumped to
// cover the readiness walk + a big createMany on a spec with hundreds of styles.
export const maxDuration = 60;

type Gate = { ok: true; userId: string; email: string | null } | { ok: false; res: NextResponse };

async function gate(): Promise<Gate> {
  const { session, role } = await getSessionWithRole();
  if (!session) return { ok: false, res: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  if (!isAdmin(role)) {
    return { ok: false, res: NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 }) };
  }
  return { ok: true, userId: session.user.id, email: session.user.email ?? null };
}

// Total previously-rejected outputs across the (uncapped) rerun set — the
// per-style `sample` is capped for display, so sum variantKeys off `toRerun`.
function totalRejectedOutputs(plan: Awaited<ReturnType<typeof computeProdSpecRerunPlan>>): number {
  return plan.toRerun.reduce((n, s) => n + s.variantKeys.length, 0);
}

// GET → the currently-REJECTED PDFs on this prod spec's live styles, named and
// grouped by style, so the "Fully approved" toggle can ask the operator to
// confirm before it re-runs + auto-approves them. Uses the SAME current-decision
// logic as the review surfaces (newest job supersedes; in-flight styles skipped).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if (!g.ok) return g.res;
  const { id } = await ctx.params;

  const plan = await computeProdSpecRerunPlan(id, { rejectedOnly: true });
  return NextResponse.json({
    active: plan.prodSpecActive,
    // Styles carrying ≥1 rejected output (all of toRerun in rejectedOnly mode).
    rejectedStyles: plan.toRerun.length,
    rejectedOutputs: totalRejectedOutputs(plan),
    // Capped, display-friendly list for the dialog. `capped` flags an "and N
    // more" tail so a spec with hundreds of rejections doesn't read as "all".
    styles: plan.sample.map((s) => ({
      id: s.id,
      name: s.name,
      poNumber: s.poNumber,
      rejected: s.rejected,
      rejectedNames: s.rejectedNames,
    })),
    capped: plan.toRerun.length > plan.sample.length,
  });
}

// POST → confirm: mark the spec "Fully approved" (so the runner auto-approves
// this and every FUTURE print-safe generation), then re-run exactly the
// previously-rejected outputs. Setting the flag BEFORE enqueue guarantees the
// fresh PDFs land APPROVED. Returns the batchId — poll rerun-styles?batchId for
// live progress (the batch-progress endpoint is generic).
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if (!g.ok) return g.res;
  const { id } = await ctx.params;

  const spec = await db.prodSpec.findUnique({ where: { id }, select: { name: true, active: true } });
  if (!spec) return NextResponse.json({ error: "Prod spec not found" }, { status: 404 });

  // Flag first: the runner reads prodSpec.fullyApproved at render time (later,
  // in the background), so this must be committed before the jobs run. It's a
  // valid state regardless of `active`, so set it either way.
  await db.prodSpec.update({ where: { id }, data: { fullyApproved: true } });

  // An inactive spec is excluded from generation — the runner would no-op every
  // job. Set the trust flag (done above) but DON'T enqueue: the rejected PDFs
  // re-run + auto-approve once the operator activates the spec and re-runs. The
  // dialog surfaces this so the flag-set isn't mistaken for a completed re-run.
  if (!spec.active) {
    const plan = await computeProdSpecRerunPlan(id, { rejectedOnly: true });
    return NextResponse.json({
      ok: true,
      fullyApproved: true,
      inactive: true,
      batchId: null,
      enqueued: 0,
      rejectedStyles: plan.toRerun.length,
      rejectedOutputs: totalRejectedOutputs(plan),
    });
  }

  const plan = await computeProdSpecRerunPlan(id, { rejectedOnly: true });
  const { batchId, enqueued } = await enqueueBulkRun({
    runnable: plan.toRerun,
    label: `Approve rejected: ${spec.name}`,
    user: { id: g.userId, email: g.email },
  });

  return NextResponse.json({
    ok: true,
    fullyApproved: true,
    inactive: false,
    batchId,
    enqueued,
    rejectedStyles: plan.toRerun.length,
    rejectedOutputs: totalRejectedOutputs(plan),
  });
}
