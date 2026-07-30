import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { triggerRunner } from "@/lib/queue/trigger";

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
  // Defaults to MANUAL_BULK (a human clicked a bulk button). SPEC_OUTPUT_ADDED
  // marks the automatic fan-out fired when a save adds an output to the spec —
  // same enqueue mechanics, but the run list must not attribute it to a click
  // nobody made. Both are email-suppressed the same way.
  triggerSource?: "MANUAL_BULK" | "SPEC_OUTPUT_ADDED";
  user: { id: string | null; email: string | null };
}): Promise<BulkRunResult> {
  const { runnable } = input;
  if (runnable.length === 0) return { batchId: null, enqueued: 0 };

  // Ids minted up front so a single createMany (not an N-deep await loop)
  // records them — keeps a multi-thousand-row run within maxDuration. No
  // per-job Log row (cf. enqueueGenerationJob): the batch is the audit record,
  // and the runner logs each job as it processes it.
  const jobs = runnable.map((r) => ({
    id: randomUUID(),
    styleId: r.id,
    prodSpecId: r.prodSpecId, // analytics snapshot, same as enqueueGenerationJob
    triggerSource: input.triggerSource ?? ("MANUAL_BULK" as const),
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

  return { batchId: batch.id, enqueued: runnable.length };
}
