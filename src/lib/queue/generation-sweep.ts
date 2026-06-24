import { db } from "@/lib/db";
import type { TriggerSource } from "@/generated/prisma/enums";
import { getAutoGenerateEnabled, getAutomationMinPo } from "@/lib/settings/app-settings";
import { pendingOutputKeysForStyle } from "@/lib/styles/output-readiness";
import { enqueueGenerationJob } from "./enqueue";

// =====================================================
// Auto-generation gate + backlog sweep.
//
// Single source of truth for "this style has ready, ungenerated outputs —
// generate them now, no manual click?". Shared by the PO→EAN resolve handoff
// (one style at a time) and the periodic backlog sweep (many styles per tick),
// so the two can never drift.
// =====================================================

// FAILED generation jobs for a style before the auto-paths give up and let it
// "float" for manual attention (mirrors the EAN 3-strike float). A successful
// render clears the gate naturally — a rendered output gets a non-FAILED asset
// and so drops out of pendingOutputKeysForStyle.
export const MAX_GEN_ATTEMPTS = 3;

export type StyleGenSkip =
  | "auto_off"
  | "prodspec_inactive"
  | "in_flight"
  | "floated"
  | "nothing_pending";

export type StyleGenDecision =
  | { enqueued: true; jobId: string; variantKeys: string[] }
  | { enqueued: false; reason: StyleGenSkip };

// Decide + enqueue generation for ONE style. Gates, cheapest-first; the first
// that fails wins. Does NOT trigger the runner — the caller fires it once.
//
//   1. auto-generate master switch (pass a pre-read value in bulk loops).
//   2. ProdSpec ACTIVE — inactive scaffolds never auto-generate.
//   3. in-flight guard — one QUEUED/RUNNING job at a time per style.
//   4. float cap — a style with ≥ MAX_GEN_ATTEMPTS FAILED jobs is left for a
//      human (a manual re-run that succeeds clears it).
//   5. pendingOutputKeysForStyle — ready outputs MINUS those already generated
//      (a non-FAILED asset). REJECTED / AWAITING_REVIEW / APPROVED outputs are
//      therefore never redone; only never-succeeded ones remain. This is where
//      "don't auto-regenerate a rejected output" lives.
export async function maybeEnqueueStyleGeneration(
  styleId: string,
  triggerSource: TriggerSource,
  opts: { autoGenerateEnabled?: boolean } = {},
): Promise<StyleGenDecision> {
  const autoOn = opts.autoGenerateEnabled ?? (await getAutoGenerateEnabled());
  if (!autoOn) return { enqueued: false, reason: "auto_off" };

  const style = await db.style.findUnique({
    where: { id: styleId },
    select: { prodSpec: { select: { active: true } } },
  });
  if (!style?.prodSpec?.active) return { enqueued: false, reason: "prodspec_inactive" };

  const inflight = await db.job.count({
    where: { styleId, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inflight > 0) return { enqueued: false, reason: "in_flight" };

  const failures = await db.job.count({ where: { styleId, status: "FAILED" } });
  if (failures >= MAX_GEN_ATTEMPTS) return { enqueued: false, reason: "floated" };

  const variantKeys = await pendingOutputKeysForStyle(styleId);
  if (variantKeys.length === 0) return { enqueued: false, reason: "nothing_pending" };

  const { jobId } = await enqueueGenerationJob({ styleId, triggerSource, variantKeys });
  return { enqueued: true, jobId, variantKeys };
}

export type GenSweepSummary = { enqueued: number; styleIds: string[]; jobIds: string[] };

// Backlog sweep: enqueue generation for up to `limit` active styles that have
// ready, ungenerated outputs and no in-flight job. Bounded per tick by design
// — a large backlog drains over several ticks instead of flooding the queue
// (and the review inbox) all at once. Caller triggers the runner afterwards.
export async function sweepReadyStyleGenerations(limit = 10): Promise<GenSweepSummary> {
  const summary: GenSweepSummary = { enqueued: 0, styleIds: [], jobIds: [] };
  if (!(await getAutoGenerateEnabled())) return summary;

  // PO cutoff: the sweep only pulls styles at/above the configured minimum PO
  // (Style.poSeq >= minPo) — the historical backlog is parked, same as the EAN
  // scrape. null = no cutoff (whole backlog). The event-driven paths (Monday
  // webhook, EAN→gen handoff) still generate newly-ready styles regardless;
  // this sweep is the bounded backstop.
  const minPo = await getAutomationMinPo();

  // Cheap prefilter: pre-generation styles on an active ProdSpec with no job
  // already in flight. Over-fetch — many candidates will have nothing pending
  // (already generated) and get skipped by the per-style gate below.
  const candidates = await db.style.findMany({
    where: {
      prodSpecId: { not: null },
      prodSpec: { is: { active: true } },
      status: { in: ["PENDING", "READY"] },
      jobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } },
      ...(minPo !== null ? { poSeq: { gte: minPo } } : {}),
    },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
    take: Math.max(limit, 1) * 5,
  });

  for (const { id } of candidates) {
    if (summary.enqueued >= limit) break;
    const decision = await maybeEnqueueStyleGeneration(id, "CRON_SWEEP", {
      autoGenerateEnabled: true,
    });
    if (decision.enqueued) {
      summary.enqueued += 1;
      summary.styleIds.push(id);
      summary.jobIds.push(decision.jobId);
    }
  }
  return summary;
}
