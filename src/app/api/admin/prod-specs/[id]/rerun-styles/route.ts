import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { enqueueBulkRun } from "@/lib/queue/bulk-run";
import { computeProdSpecRerunPlan } from "@/lib/outputs/prod-spec-rerun";

export const runtime = "nodejs";
// Enqueue-only — the jobs render in the background (runner cron), so this
// returns well under the default. Bumped to cover the readiness walk + a big
// createMany on a spec with hundreds of styles.
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

// GET ?batchId=<id> → live progress for that batch (the panel polls this after
// it starts a run, so a run begun elsewhere can't hijack the card).
// GET (no batchId) → the rerun plan summary: how many styles would rerun, the
// rejected/new-missing breakdown, and a capped "affected styles" sample so the
// operator can SEE which styles are reviewed-and-rejected before running.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if (!g.ok) return g.res;
  const { id } = await ctx.params;

  const batchId = req.nextUrl.searchParams.get("batchId");
  if (batchId) return batchProgress(batchId);

  const plan = await computeProdSpecRerunPlan(id);
  return NextResponse.json({
    active: plan.prodSpecActive,
    generatedStyles: plan.generatedStyles,
    toRerun: plan.toRerun.length,
    withMissing: plan.withMissing,
    withRejected: plan.withRejected,
    sample: plan.sample,
  });
}

// POST — enqueue the rerun plan (new/missing + rejected outputs per style),
// grouped under a BulkRunBatch. Returns the batchId for scoped progress polling.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if (!g.ok) return g.res;
  const { id } = await ctx.params;

  const spec = await db.prodSpec.findUnique({ where: { id }, select: { name: true, active: true } });
  if (!spec) return NextResponse.json({ error: "Prod spec not found" }, { status: 404 });
  // An inactive spec is excluded from generation — the runner would no-op every
  // job. Block here so the operator activates it first instead of a silent run.
  if (!spec.active) {
    return NextResponse.json(
      { error: "This prod spec is inactive — activate it before rerunning its styles." },
      { status: 409 },
    );
  }

  const plan = await computeProdSpecRerunPlan(id);
  const { batchId, enqueued } = await enqueueBulkRun({
    runnable: plan.toRerun,
    label: `Prod spec: ${spec.name}`,
    user: { id: g.userId, email: g.email },
  });

  return NextResponse.json({
    ok: true,
    batchId,
    enqueued,
    withMissing: plan.withMissing,
    withRejected: plan.withRejected,
  });
}

// Live progress for one batch — same shape + lazy-finalize as the /styles
// "Run all outputs" GET, but looked up by id (not "latest") so this panel only
// ever reflects the run it started.
async function batchProgress(batchId: string) {
  const batch = await db.bulkRunBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      label: true,
      total: true,
      jobIds: true,
      createdByEmail: true,
      createdAt: true,
      finishedAt: true,
    },
  });
  if (!batch) return NextResponse.json({ batch: null });

  const jobIds = Array.isArray(batch.jobIds) ? (batch.jobIds as string[]) : [];
  const grouped = jobIds.length
    ? await db.job.groupBy({ by: ["status"], where: { id: { in: jobIds } }, _count: { _all: true } })
    : [];

  // DONE = jobs no longer in flight (AWAITING_REVIEW / APPROVED / REJECTED /
  // FAILED). RUNNING = still QUEUED or RUNNING. FAILED surfaced separately.
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const grp of grouped) {
    const n = grp._count._all;
    if (grp.status === "QUEUED" || grp.status === "RUNNING") running += n;
    else done += n;
    if (grp.status === "FAILED") failed += n;
  }

  // Lazy finalize: stamp finishedAt the first time nothing's left in flight.
  let finishedAt = batch.finishedAt;
  if (!finishedAt && running === 0) {
    const updated = await db.bulkRunBatch.update({
      where: { id: batch.id },
      data: { finishedAt: new Date() },
      select: { finishedAt: true },
    });
    finishedAt = updated.finishedAt;
  }

  return NextResponse.json({
    batch: {
      id: batch.id,
      label: batch.label,
      total: batch.total,
      done,
      failed,
      running,
      createdByEmail: batch.createdByEmail,
      createdAt: batch.createdAt,
      finishedAt,
    },
  });
}
