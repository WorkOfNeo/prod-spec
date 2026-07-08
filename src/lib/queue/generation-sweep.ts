import { db } from "@/lib/db";
import type { TriggerSource } from "@/generated/prisma/enums";
import { getAutoGenerateEnabled, getGenerationMinPo } from "@/lib/settings/app-settings";
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

export type GenSweepSummary = {
  enqueued: number;
  // How many candidate styles the sweep actually examined this tick (bounded by
  // the over-fetch; the loop stops early once `limit` are enqueued).
  checked: number;
  // Why the checked-but-not-enqueued styles were skipped — the answer to "the
  // sweep runs but queues nothing": mostly `nothing_pending` (outputs already
  // generated or readiness-blocked) or `floated` (3+ failed jobs).
  skips: Record<StyleGenSkip, number>;
  styleIds: string[];
  jobIds: string[];
};

const emptySkips = (): Record<StyleGenSkip, number> => ({
  auto_off: 0,
  prodspec_inactive: 0,
  in_flight: 0,
  floated: 0,
  nothing_pending: 0,
});

// Compact "checked N · reason X · reason Y" line for the CronRun note (zeros
// omitted; the feed's own detail already carries enqueued/rendered/failed) so
// /automation can say WHY a tick enqueued nothing.
export function describeGenSweep(s: GenSweepSummary): string {
  const parts = Object.entries(s.skips)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason} ${n}`);
  return `checked ${s.checked}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

// Backlog sweep: enqueue generation for up to `limit` active styles that have
// ready, ungenerated outputs and no in-flight job. Bounded per tick by design
// — a large backlog drains over several ticks instead of flooding the queue
// (and the review inbox) all at once. Caller triggers the runner afterwards.
export async function sweepReadyStyleGenerations(limit = 10): Promise<GenSweepSummary> {
  const summary: GenSweepSummary = {
    enqueued: 0,
    checked: 0,
    skips: emptySkips(),
    styleIds: [],
    jobIds: [],
  };
  if (!(await getAutoGenerateEnabled())) return summary;

  // Generation PO cutoff: the sweep only pulls styles at/above the configured
  // minimum PO (Style.poSeq >= minPo) — the historical backlog is parked.
  // Dedicated to generation (falls back to the scrape cutoff when unset, see
  // getGenerationMinPo). null = no cutoff (whole backlog). Styles with no
  // parseable PO (poSeq IS NULL) are NOT parked — they can't be placed on the
  // PO timeline, and a ready output should still generate, so the filter is
  // "poSeq >= minPo OR poSeq IS NULL". The event-driven paths (Monday webhook,
  // EAN→gen handoff) still generate newly-ready styles regardless; this sweep
  // is the bounded backstop.
  const minPo = await getGenerationMinPo();

  // Cheap prefilter: pre-generation styles on an active ProdSpec with no job
  // already in flight. Over-fetch — many candidates will have nothing pending
  // (already generated) and get skipped by the per-style gate below.
  const candidates = await db.style.findMany({
    where: {
      prodSpecId: { not: null },
      prodSpec: { is: { active: true } },
      status: { in: ["PENDING", "READY"] },
      jobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } },
      ...(minPo !== null ? { OR: [{ poSeq: { gte: minPo } }, { poSeq: null }] } : {}),
    },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
    take: Math.max(limit, 1) * 5,
  });

  for (const { id } of candidates) {
    if (summary.enqueued >= limit) break;
    summary.checked += 1;
    const decision = await maybeEnqueueStyleGeneration(id, "CRON_SWEEP", {
      autoGenerateEnabled: true,
    });
    if (decision.enqueued) {
      summary.enqueued += 1;
      summary.styleIds.push(id);
      summary.jobIds.push(decision.jobId);
    } else {
      summary.skips[decision.reason] += 1;
    }
  }
  return summary;
}
