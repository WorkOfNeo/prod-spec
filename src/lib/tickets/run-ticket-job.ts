import { db } from "@/lib/db";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { runPendingJobs } from "@/lib/queue/runner";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { currentOutputBaseKeys, isOrphanedOutputKey } from "./orphan";

// =====================================================
// Shared run path for the two ticket actions ("Re-run output" and "Mark
// fixed & notify"): enqueue a job scoped to the ticket's output and run
// the queue inline until THAT job settles. Mirrors the manual rerun route
// (/api/admin/styles/[id]/rerun) — the admin clicked and is waiting — but
// with TICKET_* trigger sources so the runner keeps the generic
// review-ready email quiet.
// =====================================================

export class TicketRunError extends Error {
  constructor(
    public readonly httpStatus: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "TicketRunError";
  }
}

export type TicketRunResult = {
  // The ticket's output was REMOVED from the spec (swapped/deleted), so we
  // resolved the ticket in place and ran NO job — there's nothing to
  // regenerate. jobId/jobStatus are null in this case.
  removedOutput: boolean;
  jobId: string | null;
  // Terminal state of OUR job after the inline run loop.
  jobStatus: string | null;
  jobError: string | null;
  // The freshly generated asset for the ticket's output (when the run
  // succeeded) — lets the workbench jump straight to the new preview.
  latestAsset: {
    id: string;
    jobId: string;
    variantKey: string | null;
    docType: string;
    displayName: string | null;
    placeholderCount: number;
  } | null;
};

export async function runTicketJob(input: {
  ticket: { id: string; styleId: string; variantKey: string; docType: string };
  triggerSource: "TICKET_RERUN" | "TICKET_FIX";
  userEmail: string;
}): Promise<TicketRunResult> {
  const { ticket } = input;

  const style = await db.style.findUnique({
    where: { id: ticket.styleId },
    select: { id: true, prodSpec: { select: { outputs: true } } },
  });
  if (!style) throw new TicketRunError(404, "Style behind this ticket no longer exists");

  // Orphaned ticket: its output was removed/replaced on the ProdSpec since the
  // rejection. A scoped re-run would match no current output and NO_OUTPUTS-fail
  // (which also poisons the auto-gen float cap), so resolve the ticket in place
  // — nothing to regenerate. See lib/tickets/orphan.ts.
  if (style.prodSpec && isOrphanedOutputKey(ticket.variantKey, currentOutputBaseKeys(parseProdSpecOutputs(style.prodSpec.outputs)))) {
    await db.rejectionTicket.update({
      where: { id: ticket.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    return { removedOutput: true, jobId: null, jobStatus: null, jobError: null, latestAsset: null };
  }

  const inflight = await db.job.count({
    where: { styleId: ticket.styleId, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inflight > 0) {
    throw new TicketRunError(409, "A job is already in flight for this style — wait for it to finish");
  }

  // "" variantKey = legacy asset without a per-variant key; the scoped
  // re-run then regenerates the full job (empty scope = all outputs).
  const variantKeys = ticket.variantKey ? [ticket.variantKey] : [];
  const { jobId } = await enqueueGenerationJob({
    styleId: ticket.styleId,
    triggerSource: input.triggerSource,
    variantKeys,
  });
  await db.style.update({ where: { id: ticket.styleId }, data: { status: "GENERATING" } });
  await db.log.create({
    data: {
      jobId,
      level: "INFO",
      message: `${input.triggerSource === "TICKET_FIX" ? "fix" : "silent"} re-run from rejection ticket ${ticket.id}${
        variantKeys.length > 0 ? ` (output: ${variantKeys[0]})` : ""
      } by ${input.userEmail}`,
    },
  });

  // The runner claims QUEUED jobs oldest-first, so a backlog from other
  // styles can be ahead of ours. Drain one at a time until OUR job leaves
  // the queue (bounded — the cron picks up anything we leave behind).
  for (let i = 0; i < 5; i++) {
    await runPendingJobs(1);
    const j = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });
    if (j && j.status !== "QUEUED" && j.status !== "RUNNING") break;
  }

  const job = await db.job.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      status: true,
      error: true,
      assets: {
        select: {
          id: true,
          jobId: true,
          variantKey: true,
          docType: true,
          displayName: true,
          placeholderCount: true,
        },
      },
    },
  });

  const latestAsset =
    job.assets.find((a) => (ticket.variantKey ? a.variantKey === ticket.variantKey : true)) ?? null;

  return {
    removedOutput: false,
    jobId,
    jobStatus: job.status,
    jobError: job.error ?? null,
    latestAsset,
  };
}
