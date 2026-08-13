import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { triggerRunner } from "@/lib/queue/trigger";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { getGenerationMinPo } from "@/lib/settings/app-settings";
import { partitionByGenerationCutoff } from "@/lib/queue/generation-cutoff";
import { HAS_PO_NUMBER_WHERE } from "@/lib/styles/active-filter";
import type { JobStatus } from "@/generated/prisma/enums";

export const runtime = "nodejs";
// Enqueue-only — the jobs render in the background (runner cron).
export const maxDuration = 60;

// "Regenerate all (keep approved)" — the second /styles bulk action. Where
// bulk-rerun fills GAPS (ready outputs that were never generated), this one
// REFRESHES: every style in the filter that already has ≥1 generated output
// gets one FULL (unscoped) job, so stale PDFs are re-rendered after a data
// fix (e.g. the PO EAN re-resolve). The "approved stays approved" rule is NOT
// this route's job — the runner applies durable approval to every full run
// (currently-approved outputs are carried forward, never re-rendered), and
// readiness-gating still blocks outputs with missing fields. A style whose
// outputs are all approved settles APPROVED without rendering anything.
//
// Same contract as bulk-rerun: the browser POSTs the current filtered ids,
// jobs group under a BulkRunBatch (progress via bulk-rerun's GET), and
// MANUAL_BULK suppresses the review-ready emails (in-app inbox only).
const BODY = z.object({
  styleIds: z.array(z.string().min(1)).min(1).max(5000),
  label: z.string().max(300).optional(),
  // Include styles below the generation PO cutoff. Default false — this lane
  // runs what the automatic sweep would also reach and reports the parked rest,
  // so a filter that happens to span old orders can't quietly regenerate the
  // archive. See lib/queue/generation-cutoff.ts.
  includeBelowCutoff: z.boolean().optional(),
});

const IN_FLIGHT: JobStatus[] = ["QUEUED", "RUNNING"];

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

  // Candidates: exist AND carry a PO number AND an active prod spec (no PO ⇒
  // not in the flow at all and hidden from /styles; no spec ⇒ can't generate).
  // The PO clause is the list's own predicate, so a bulk action can't generate
  // for a row the operator can't even see.
  const candidates = await db.style.findMany({
    where: { id: { in: requestedIds }, ...HAS_PO_NUMBER_WHERE, prodSpec: { active: true } },
    select: { id: true, prodSpecId: true, poSeq: true },
  });
  const candidateIds = candidates.map((c) => c.id);

  // "Has ≥1 generated output" = a JobAsset on a non-FAILED job whose key is a
  // real output (framing pages — cover / retired general info — don't count:
  // a style with only a cover has nothing to REgenerate; the gap-filling
  // bulk-rerun is the right tool there).
  const assets = candidateIds.length
    ? await db.jobAsset.findMany({
        where: {
          job: { styleId: { in: candidateIds }, status: { not: "FAILED" } },
          variantKey: { notIn: [COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY], not: null },
        },
        select: { job: { select: { styleId: true } } },
        distinct: ["jobId"],
      })
    : [];
  const generatedStyleIds = new Set(assets.map((a) => a.job.styleId));

  // Don't double-enqueue a style that's already mid-flight (silently skipped).
  const inflight = await db.job.findMany({
    where: { styleId: { in: candidateIds }, status: { in: IN_FLIGHT } },
    select: { styleId: true },
    distinct: ["styleId"],
  });
  const inflightSet = new Set(inflight.map((j) => j.styleId));

  const eligible = candidates.filter(
    (c) => generatedStyleIds.has(c.id) && !inflightSet.has(c.id),
  );

  // The generation cutoff, applied the same way the prod-spec panel applies it.
  const cutoff = await getGenerationMinPo();
  const { inScope: runnable, belowCutoff } = partitionByGenerationCutoff(
    eligible,
    parsed.data.includeBelowCutoff ? null : cutoff,
  );

  if (runnable.length === 0) {
    return NextResponse.json({
      ok: true,
      batchId: null,
      enqueued: 0,
      skipped: requestedIds.length,
      skippedBelowCutoff: belowCutoff.length,
      cutoff,
    });
  }

  // One FULL job per style — variantKeys [] is the runner's "full regen"
  // contract, which is what routes durable approval / exclusions / readiness
  // through the same path as the per-style Re-run button.
  const jobs = runnable.map((r) => ({
    id: randomUUID(),
    styleId: r.id,
    prodSpecId: r.prodSpecId, // analytics snapshot, same as enqueueGenerationJob
    triggerSource: "MANUAL_BULK" as const,
    status: "QUEUED" as const,
    variantKeys: [] as string[],
  }));
  await db.job.createMany({ data: jobs });
  await db.style.updateMany({
    where: { id: { in: runnable.map((r) => r.id) } },
    data: { status: "GENERATING" },
  });

  const batch = await db.bulkRunBatch.create({
    data: {
      createdById: session.user.id,
      createdByEmail: session.user.email ?? null,
      label: parsed.data.label?.trim() || `Regenerate ${runnable.length} styles`,
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
    // Called out separately from `skipped` (which lumps together "no spec",
    // "never generated" and "in flight"): parked backlog is the one skip the
    // operator can act on, by ticking include or lowering the cutoff.
    skippedBelowCutoff: belowCutoff.length,
    cutoff,
  });
}
