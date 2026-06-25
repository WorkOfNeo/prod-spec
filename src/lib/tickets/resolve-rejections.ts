import { db } from "@/lib/db";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { runPendingJobs } from "@/lib/queue/runner";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { styleOutputBases, type StyleOutputBase } from "@/lib/rejection-log/style-outputs";
import { baseVariantKey, currentOutputBaseKeys, isOrphanedOutputKey } from "./orphan";

// =====================================================
// Style-level "resolve rejections" — the smart successor to clicking
// "Mark fixed" one output at a time.
//
// The operator's real loop is spec-wide: they fix the ProdSpec / data, hit
// "Rerun" (which refreshes the cover, general info AND every output), then
// come here to hand it back. So this:
//   • SKIPS re-rendering any rejected output already regenerated since its
//     rejection (e.g. by that Prod Spec rerun) — no redundant second render,
//   • re-renders only the STALE ones (or everything, when regenerateAll),
//   • resolves orphaned tickets in place (output removed from the spec),
//   • leaves AWAITING-DATA outputs OPEN (can't fix a PDF that can't build yet),
//   • marks the rest FIXED.
// The caller (route) sends ONE re-review notification for the whole batch.
//
// Freshness is decided by styleOutputBases: a rejected output is "fresh" when
// its newest non-FAILED asset post-dates the ticket's rejection time.
// =====================================================

type OpenTicket = {
  id: string;
  variantKey: string;
  outputName: string;
  createdAt: Date;
  reportedById: string;
};

export type ResolveOutcome = {
  // Tickets advanced to FIXED. reRendered = we re-ran it now (vs. it was
  // already fresh from an earlier rerun and we just marked it).
  fixed: Array<{ ticketId: string; variantKey: string; outputName: string; reRendered: boolean; reportedById: string }>;
  // Left OPEN — the output's required fields aren't all present yet.
  awaitingData: Array<{ ticketId: string; variantKey: string; outputName: string; missing: string[] }>;
  // Resolved in place — the output was removed/replaced on the ProdSpec.
  resolvedOrphan: Array<{ ticketId: string; variantKey: string; outputName: string }>;
  // Re-render ran but produced no newer asset (left OPEN).
  failed: Array<{ ticketId: string; variantKey: string; outputName: string; error: string }>;
  // The generation job we ran, if any.
  jobId: string | null;
};

const empty = (): ResolveOutcome => ({
  fixed: [],
  awaitingData: [],
  resolvedOrphan: [],
  failed: [],
  jobId: null,
});

const isFresh = (ticket: OpenTicket, output: StyleOutputBase | undefined): boolean =>
  !!output?.lastGeneratedAt && output.lastGeneratedAt > ticket.createdAt;

export async function resolveStyleRejections(input: {
  styleId: string;
  // true ⇒ full-style rerun first (cover + general info + every output), then
  // mark everything fixed. false ⇒ smart: re-render only stale outputs.
  regenerateAll: boolean;
}): Promise<ResolveOutcome> {
  const tickets: OpenTicket[] = await db.rejectionTicket.findMany({
    where: { styleId: input.styleId, status: { in: ["OPEN", "IN_PROGRESS"] } },
    select: { id: true, variantKey: true, outputName: true, createdAt: true, reportedById: true },
  });
  if (tickets.length === 0) return empty();

  const style = await db.style.findUnique({
    where: { id: input.styleId },
    select: { prodSpec: { select: { outputs: true } } },
  });
  const currentBaseKeys = currentOutputBaseKeys(parseProdSpecOutputs(style?.prodSpec?.outputs ?? []));

  let byBase = new Map((await styleOutputBases(input.styleId)).map((o) => [o.variantKey, o]));

  const outcome = empty();
  const candidates: OpenTicket[] = []; // ready, non-orphan — fresh or stale
  for (const t of tickets) {
    if (isOrphanedOutputKey(t.variantKey, currentBaseKeys)) {
      await db.rejectionTicket.update({
        where: { id: t.id },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
      outcome.resolvedOrphan.push({ ticketId: t.id, variantKey: t.variantKey, outputName: t.outputName });
      continue;
    }
    const o = byBase.get(baseVariantKey(t.variantKey));
    if (o && !o.ready) {
      outcome.awaitingData.push({ ticketId: t.id, variantKey: t.variantKey, outputName: t.outputName, missing: o.missing });
      continue;
    }
    candidates.push(t);
  }

  // Which outputs actually need a render? Everything when regenerateAll;
  // otherwise only the candidates not already refreshed since their rejection.
  const staleBases = new Set<string>();
  for (const t of candidates) {
    const b = baseVariantKey(t.variantKey);
    if (input.regenerateAll || !isFresh(t, byBase.get(b))) staleBases.add(b);
  }

  if (input.regenerateAll || staleBases.size > 0) {
    // Empty variantKeys ⇒ full regen (cover + general info + all outputs).
    const variantKeys = input.regenerateAll ? [] : [...staleBases];
    const { jobId } = await enqueueGenerationJob({
      styleId: input.styleId,
      // Keep the runner's generic review-ready email quiet — we send our own
      // single batched re-review notification from the route.
      triggerSource: "TICKET_FIX",
      variantKeys,
    });
    outcome.jobId = jobId;
    await db.style.update({ where: { id: input.styleId }, data: { status: "GENERATING" } });
    // Drain oldest-first until OUR job settles (a backlog may be ahead).
    for (let i = 0; i < 6; i++) {
      await runPendingJobs(1);
      const j = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });
      if (j && j.status !== "QUEUED" && j.status !== "RUNNING") break;
    }
    // Re-read freshness after the render so the mark-fixed decision below
    // sees the brand-new assets.
    byBase = new Map((await styleOutputBases(input.styleId)).map((o) => [o.variantKey, o]));
  }

  for (const t of candidates) {
    const b = baseVariantKey(t.variantKey);
    if (isFresh(t, byBase.get(b))) {
      await db.rejectionTicket.update({
        where: { id: t.id },
        data: { status: "FIXED", fixedAt: new Date() },
      });
      outcome.fixed.push({
        ticketId: t.id,
        variantKey: t.variantKey,
        outputName: t.outputName,
        reRendered: staleBases.has(b),
        reportedById: t.reportedById,
      });
    } else {
      outcome.failed.push({
        ticketId: t.id,
        variantKey: t.variantKey,
        outputName: t.outputName,
        error: "re-render produced no newer version — check the job log",
      });
    }
  }

  return outcome;
}
