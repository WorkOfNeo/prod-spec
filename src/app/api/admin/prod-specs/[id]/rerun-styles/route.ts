import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { enqueueBulkRun } from "@/lib/queue/bulk-run";
import { listProdSpecStyleRuns } from "@/lib/outputs/prod-spec-rerun";
import { getVariant } from "@/lib/pdf/template-registry";

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
// it starts a "Run all", so a run begun elsewhere can't hijack the card).
// GET (no batchId) → the full run list: EVERY active style on this spec, each
// with its scoped run set (new/missing + rejected ready outputs), a last-run
// stamp, and whether that run was automated or manual. The table shows this;
// per-row Run buttons post to /api/admin/styles/[id]/rerun with the row's keys.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if (!g.ok) return g.res;
  const { id } = await ctx.params;

  const batchId = req.nextUrl.searchParams.get("batchId");
  if (batchId) return batchProgress(batchId);

  const list = await listProdSpecStyleRuns(id);
  return NextResponse.json(list);
}

// POST — "Run all": enqueue every runnable style on the spec (new/missing +
// rejected + changed outputs each, approved work left alone; in-flight styles
// skipped), grouped under a BulkRunBatch. Returns the batchId for scoped
// progress polling.
//
// Optional JSON body { variantKey } scopes the run to ONE output: the per-output
// "Run all" button on each Outputs-tab row. Only that output's base key is
// enqueued, and only for the styles where it's missing / rejected / changed.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await gate();
  if (!g.ok) return g.res;
  const { id } = await ctx.params;

  // Optional per-output scope. Tolerate an empty/absent body (spec-wide run).
  const body = (await req.json().catch(() => ({}))) as {
    variantKey?: unknown;
    includeBelowCutoff?: unknown;
  };
  const scopeKey =
    typeof body.variantKey === "string" && body.variantKey.trim().length > 0
      ? body.variantKey.split("#")[0] // compare against base keys
      : null;
  // Opt-in to the parked backlog. Default false — "Run all" covers the styles
  // the automatic sweep would also reach, and reports the rest rather than
  // sweeping a spec's whole history along with them.
  const includeBelowCutoff = body.includeBelowCutoff === true;

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

  // Same source of truth as the list the operator is looking at: run the rows
  // that have outputs to regenerate and aren't already in flight. When scoped,
  // keep only the one output's key on each row and drop rows that don't carry it.
  const list = await listProdSpecStyleRuns(id);
  const runnable = list.rows
    .filter((r) => !r.inFlight && r.variantKeys.length > 0)
    .map((r) => ({
      id: r.id,
      prodSpecId: id,
      variantKeys: scopeKey ? r.variantKeys.filter((k) => k.split("#")[0] === scopeKey) : r.variantKeys,
    }))
    .filter((r) => r.variantKeys.length > 0);

  const scopeName = scopeKey ? (getVariant(scopeKey)?.name ?? scopeKey) : null;
  const { batchId, enqueued, skippedBelowCutoff, cutoff } = await enqueueBulkRun({
    runnable,
    label: scopeName ? `Prod spec: ${spec.name} · ${scopeName}` : `Prod spec: ${spec.name}`,
    user: { id: g.userId, email: g.email },
    includeBelowCutoff,
  });

  const summary = scopeKey ? list.byOutput[scopeKey] : null;
  return NextResponse.json({
    ok: true,
    batchId,
    enqueued,
    // What the run deliberately left parked, and where the line was — so the
    // panel can say "18 started · 91 below PO 63320 left out" instead of
    // silently starting fewer jobs than the button implied.
    skippedBelowCutoff,
    cutoff,
    variantKey: scopeKey,
    withMissing: summary ? summary.missing : list.withMissing,
    withRejected: summary ? summary.rejected : list.withRejected,
    withChanged: summary ? summary.changed : list.withChanged,
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
