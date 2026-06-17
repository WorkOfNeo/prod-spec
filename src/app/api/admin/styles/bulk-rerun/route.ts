import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { triggerRunner } from "@/lib/queue/trigger";
import type { JobStatus } from "@/generated/prisma/enums";

export const runtime = "nodejs";
// Enqueue-only — the jobs render in the background (runner cron), so this
// returns in well under the default. Bumped a little to cover a big createMany.
export const maxDuration = 60;

// The /styles table filters client-side, so the browser already holds the
// exact filtered set. It POSTs those ids straight through — no need to
// re-derive the filter here (one source of truth for what "the current list"
// is). Capped at the table's load ceiling so a runaway body can't enqueue
// unbounded work.
const BODY = z.object({
  styleIds: z.array(z.string().min(1)).min(1).max(5000),
  label: z.string().max(300).optional(),
});

const IN_FLIGHT: JobStatus[] = ["QUEUED", "RUNNING"];

// POST — enqueue one full re-run job per eligible style in the current filter,
// group them under a BulkRunBatch, and kick the runner once. Does NOT render
// inline (hundreds × ~300 s would time out): the runner cron drains the queue
// while the page polls GET below for DONE/TOTAL.
export async function POST(req: NextRequest) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });
  }

  const parsed = BODY.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  const requestedIds = [...new Set(parsed.data.styleIds)];

  // Only enqueue styles that can actually produce something: they exist AND
  // carry an active prod spec. A style with no active spec can't generate, so
  // a job would just no-op — skip it and report it as skipped (honest count).
  const candidates = await db.style.findMany({
    where: { id: { in: requestedIds }, prodSpec: { active: true } },
    select: { id: true, prodSpecId: true },
  });

  // Don't double-enqueue a style that's already mid-flight (matches the single
  // re-run's 409 guard, but here we silently skip rather than fail the batch).
  const inflight = await db.job.findMany({
    where: { styleId: { in: candidates.map((c) => c.id) }, status: { in: IN_FLIGHT } },
    select: { styleId: true },
    distinct: ["styleId"],
  });
  const inflightSet = new Set(inflight.map((j) => j.styleId));
  const toRun = candidates.filter((c) => !inflightSet.has(c.id));

  if (toRun.length === 0) {
    return NextResponse.json({ ok: true, batchId: null, enqueued: 0, skipped: requestedIds.length });
  }

  // Generate the job ids up front so a single createMany (not an N-deep await
  // loop) records them — keeps "Run all" on a 4k-row board within maxDuration.
  // No per-job Log row here (cf. enqueueGenerationJob): the batch is the audit
  // record, and the runner logs each job as it processes it.
  const jobs = toRun.map((c) => ({
    id: randomUUID(),
    styleId: c.id,
    prodSpecId: c.prodSpecId, // analytics snapshot, same as enqueueGenerationJob
    triggerSource: "MANUAL_BULK" as const,
    status: "QUEUED" as const,
  }));
  await db.job.createMany({ data: jobs });
  await db.style.updateMany({ where: { id: { in: toRun.map((c) => c.id) } }, data: { status: "GENERATING" } });

  const batch = await db.bulkRunBatch.create({
    data: {
      createdById: session.user.id,
      createdByEmail: session.user.email ?? null,
      label: parsed.data.label?.trim() || `${toRun.length} styles`,
      total: toRun.length,
      styleIds: toRun.map((c) => c.id),
      jobIds: jobs.map((j) => j.id),
    },
    select: { id: true },
  });

  // One immediate kick; the Railway cron keeps draining the backlog after.
  await triggerRunner();

  return NextResponse.json({
    ok: true,
    batchId: batch.id,
    enqueued: toRun.length,
    skipped: requestedIds.length - toRun.length,
  });
}

// GET — the latest batch with live progress, polled by the /styles toolbar so
// the run is visible after navigating away and back. Mirrors the SyncJob
// progress endpoint (/api/admin/sync/progress).
export async function GET() {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });
  }

  const batch = await db.bulkRunBatch.findFirst({
    orderBy: { createdAt: "desc" },
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
    ? await db.job.groupBy({
        by: ["status"],
        where: { id: { in: jobIds } },
        _count: { _all: true },
      })
    : [];

  // DONE = jobs no longer in flight (terminal: AWAITING_REVIEW / APPROVED /
  // REJECTED / FAILED). RUNNING = still QUEUED or RUNNING. FAILED is surfaced
  // separately so the bar can show "N done · M failed".
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const g of grouped) {
    const n = g._count._all;
    if (g.status === "QUEUED" || g.status === "RUNNING") running += n;
    else done += n;
    if (g.status === "FAILED") failed += n;
  }

  // Lazy finalize: stamp finishedAt the first time nothing's left in flight.
  // (Using running===0 rather than done>=total stays correct even if some job
  // rows were pruned — e.g. a style was deleted mid-run.)
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
