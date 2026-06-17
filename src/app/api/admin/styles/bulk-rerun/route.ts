import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { triggerRunner } from "@/lib/queue/trigger";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { outputReadinessForStyle } from "@/lib/styles/output-readiness";
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

// POST — for every eligible style in the current filter, enqueue ONE job scoped
// to that style's READY, not-yet-generated outputs (not a full re-run), group
// them under a BulkRunBatch, and kick the runner once. Scoping to ready outputs
// is the whole point: an unready output must never render as a placeholder, and
// skipping already-generated ones avoids re-reviewing approved work — same rule
// as the auto-generate sweep (pendingOutputKeysForStyle). Does NOT render inline
// — the runner drains the queue while the page polls GET below for DONE/TOTAL.
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

  // ProdSpec.outputs can reference Output Builder layouts (`layout:<id>` keys) —
  // load them into the variant registry before the readiness walk resolves them.
  await ensureLayoutVariantsLoaded();

  // Candidates: exist AND carry an active prod spec (no spec ⇒ can't generate).
  // Pull exactly the fields readiness reads (mirrors the /styles page query and
  // pendingOutputKeysForStyle) so the ready check here matches the real render.
  const candidates = await db.style.findMany({
    where: { id: { in: requestedIds }, prodSpec: { active: true } },
    select: {
      id: true,
      prodSpecId: true,
      rawData: true,
      poNumber: true,
      cartonEan: true,
      supplier: { select: { country: true } },
      eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true } },
      customer: { select: { config: true } },
      prodSpec: { select: { outputs: true, columnMapping: true } },
    },
  });
  const candidateIds = candidates.map((c) => c.id);

  // Outputs already generated for these styles (a JobAsset on a non-FAILED job)
  // — excluded so we don't redo awaiting/approved work. One batched query; keyed
  // by style, bases compared (multi-doc assets are "<variantKey>#<suffix>").
  const assets = candidateIds.length
    ? await db.jobAsset.findMany({
        where: {
          job: { styleId: { in: candidateIds }, status: { not: "FAILED" } },
          variantKey: { not: null },
        },
        select: { variantKey: true, job: { select: { styleId: true } } },
      })
    : [];
  const generatedByStyle = new Map<string, Set<string>>();
  for (const a of assets) {
    if (!a.variantKey) continue;
    const set = generatedByStyle.get(a.job.styleId) ?? new Set<string>();
    set.add(a.variantKey.split("#")[0]);
    generatedByStyle.set(a.job.styleId, set);
  }

  // Don't double-enqueue a style that's already mid-flight (silently skipped).
  const inflight = await db.job.findMany({
    where: { styleId: { in: candidateIds }, status: { in: IN_FLIGHT } },
    select: { styleId: true },
    distinct: ["styleId"],
  });
  const inflightSet = new Set(inflight.map((j) => j.styleId));

  // Per style: ready outputs MINUS already-generated. A style with nothing
  // pending (no ready outputs, or all already done) or one mid-flight is
  // skipped — running it would render placeholders or redo finished work.
  const runnable: Array<{ id: string; prodSpecId: string | null; variantKeys: string[] }> = [];
  for (const c of candidates) {
    if (inflightSet.has(c.id)) continue;
    const generated = generatedByStyle.get(c.id);
    const pending = outputReadinessForStyle(c)
      .filter((o) => o.ready)
      .map((o) => o.variantKey)
      .filter((k) => !generated?.has(k));
    if (pending.length === 0) continue;
    runnable.push({ id: c.id, prodSpecId: c.prodSpecId, variantKeys: pending });
  }

  if (runnable.length === 0) {
    return NextResponse.json({ ok: true, batchId: null, enqueued: 0, skipped: requestedIds.length });
  }

  // One job per runnable style, SCOPED to its ready+pending outputs. Ids minted
  // up front for a single createMany (cf. enqueueGenerationJob). The runner
  // re-checks each variant's readiness at render time, so a field that regresses
  // between here and render still won't ship an incomplete output.
  const jobs = runnable.map((r) => ({
    id: randomUUID(),
    styleId: r.id,
    prodSpecId: r.prodSpecId, // analytics snapshot, same as enqueueGenerationJob
    triggerSource: "MANUAL_BULK" as const,
    status: "QUEUED" as const,
    variantKeys: r.variantKeys,
  }));
  await db.job.createMany({ data: jobs });
  await db.style.updateMany({ where: { id: { in: runnable.map((r) => r.id) } }, data: { status: "GENERATING" } });

  const batch = await db.bulkRunBatch.create({
    data: {
      createdById: session.user.id,
      createdByEmail: session.user.email ?? null,
      label: parsed.data.label?.trim() || `${runnable.length} styles`,
      total: runnable.length,
      styleIds: runnable.map((r) => r.id),
      jobIds: jobs.map((j) => j.id),
    },
    select: { id: true },
  });

  // One immediate kick; the self-chaining runner drains the rest continuously.
  await triggerRunner();

  return NextResponse.json({
    ok: true,
    batchId: batch.id,
    enqueued: runnable.length,
    skipped: requestedIds.length - runnable.length,
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
