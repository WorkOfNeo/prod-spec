import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { triggerRunner } from "@/lib/queue/trigger";
import { HAS_PO_NUMBER_WHERE, hasPoNumber } from "@/lib/styles/active-filter";

// One style to (re)generate, with the exact output variant keys to render.
// An empty variantKeys array would mean "all enabled outputs" to the runner —
// callers here always pass an explicit, readiness-checked subset.
export type RunnableStyle = {
  id: string;
  prodSpecId: string | null;
  variantKeys: string[];
};

export type BulkRunResult = {
  // null when nothing was enqueued (empty runnable set).
  batchId: string | null;
  enqueued: number;
  // Dropped here for having no PO number ("Navision Task"). Reported rather
  // than thrown: a bulk action over a mixed selection should run the styles
  // that are in the flow and tell the operator how many weren't.
  skippedNoPo: number;
};

/**
 * Enqueue one generation job per runnable style — each SCOPED to its given
 * variantKeys — group them under a BulkRunBatch, mark the styles GENERATING,
 * and kick the runner once. The shared enqueue tail for admin bulk actions
 * (the /styles "Run all outputs" toolbar computes its own runnable set; the
 * per-ProdSpec "Rerun all styles" action computes its own — both end here).
 *
 * MANUAL_BULK makes the runner suppress the per-style review-email blast (a
 * big run mustn't send hundreds of emails) while still recording in-app review
 * notifications — see src/lib/queue/runner.ts. The runner re-checks each
 * variant's readiness at render time, so a field that regresses between here
 * and render still won't ship an incomplete output.
 *
 * Does NOT render inline (hundreds × ~300 s would time out): the runner cron
 * drains the queue while the UI polls the BulkRunBatch for DONE/TOTAL.
 */
export async function enqueueBulkRun(input: {
  runnable: RunnableStyle[];
  // Stored on the batch for the progress widget. Falls back to "N styles".
  label: string;
  user: { id: string | null; email: string | null };
}): Promise<BulkRunResult> {
  // The PO gate for the bulk lane. This helper creates jobs with createMany and
  // so never reaches enqueueGenerationJob's throw — the check has to happen
  // here, on the one tail both bulk callers share. Queried in a single pass
  // over the requested ids rather than trusting the callers to have filtered.
  const withPo = await db.style.findMany({
    where: { id: { in: input.runnable.map((r) => r.id) }, ...HAS_PO_NUMBER_WHERE },
    select: { id: true, poNumber: true },
  });
  const allowed = new Set(withPo.filter((s) => hasPoNumber(s.poNumber)).map((s) => s.id));
  const runnable = input.runnable.filter((r) => allowed.has(r.id));
  const skippedNoPo = input.runnable.length - runnable.length;

  if (runnable.length === 0) return { batchId: null, enqueued: 0, skippedNoPo };

  // Ids minted up front so a single createMany (not an N-deep await loop)
  // records them — keeps a multi-thousand-row run within maxDuration. No
  // per-job Log row (cf. enqueueGenerationJob): the batch is the audit record,
  // and the runner logs each job as it processes it.
  const jobs = runnable.map((r) => ({
    id: randomUUID(),
    styleId: r.id,
    prodSpecId: r.prodSpecId, // analytics snapshot, same as enqueueGenerationJob
    triggerSource: "MANUAL_BULK" as const,
    status: "QUEUED" as const,
    variantKeys: r.variantKeys,
  }));
  await db.job.createMany({ data: jobs });
  await db.style.updateMany({
    where: { id: { in: runnable.map((r) => r.id) } },
    data: { status: "GENERATING" },
  });

  const batch = await db.bulkRunBatch.create({
    data: {
      createdById: input.user.id,
      createdByEmail: input.user.email,
      label: input.label.trim() || `${runnable.length} styles`,
      total: runnable.length,
      styleIds: runnable.map((r) => r.id),
      jobIds: jobs.map((j) => j.id),
    },
    select: { id: true },
  });

  // One immediate kick; the Railway cron keeps draining the backlog after.
  await triggerRunner();

  return { batchId: batch.id, enqueued: runnable.length, skippedNoPo };
}
