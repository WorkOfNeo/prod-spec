import { db } from "@/lib/db";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { runPendingJobs } from "@/lib/queue/runner";

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
  jobId: string;
  // Terminal state of OUR job after the inline run loop.
  jobStatus: string;
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

  const style = await db.style.findUnique({ where: { id: ticket.styleId }, select: { id: true } });
  if (!style) throw new TicketRunError(404, "Style behind this ticket no longer exists");

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
    jobId,
    jobStatus: job.status,
    jobError: job.error ?? null,
    latestAsset,
  };
}
