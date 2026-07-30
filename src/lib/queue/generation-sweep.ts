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
//
// Stamps Style.outputsCheckedVersion on every SETTLED outcome (enqueued /
// nothing_pending / floated) so the sweep's version-gap candidate class doesn't
// re-offer the same style every tick. `in_flight` is deliberately NOT stamped —
// it's transient, and the style must be re-offered once its job lands.
export async function maybeEnqueueStyleGeneration(
  styleId: string,
  triggerSource: TriggerSource,
  opts: { autoGenerateEnabled?: boolean } = {},
): Promise<StyleGenDecision> {
  const autoOn = opts.autoGenerateEnabled ?? (await getAutoGenerateEnabled());
  if (!autoOn) return { enqueued: false, reason: "auto_off" };

  // outputsVersion is additive — before its db:deploy the select would throw and
  // take the whole sweep with it, so fall back to the version-free read. A null
  // version simply means "nothing to stamp"; the gate below is unaffected.
  let spec: { active: boolean; outputsVersion: number | null } | null;
  try {
    const row = await db.style.findUnique({
      where: { id: styleId },
      select: { prodSpec: { select: { active: true, outputsVersion: true } } },
    });
    spec = row?.prodSpec ?? null;
  } catch {
    const row = await db.style.findUnique({
      where: { id: styleId },
      select: { prodSpec: { select: { active: true } } },
    });
    spec = row?.prodSpec ? { active: row.prodSpec.active, outputsVersion: null } : null;
  }
  if (!spec?.active) return { enqueued: false, reason: "prodspec_inactive" };

  // Read the spec's version BEFORE the readiness walk: an edit landing mid-check
  // must leave the style behind (re-swept next tick), never stamp over the newer
  // version with a decision made against the older output set.
  const specVersion = spec.outputsVersion;
  const settle = async <T extends StyleGenDecision>(decision: T): Promise<T> => {
    await stampOutputsChecked(styleId, specVersion);
    return decision;
  };

  const inflight = await db.job.count({
    where: { styleId, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inflight > 0) return { enqueued: false, reason: "in_flight" };

  const failures = await db.job.count({ where: { styleId, status: "FAILED" } });
  if (failures >= MAX_GEN_ATTEMPTS) return settle({ enqueued: false, reason: "floated" });

  const variantKeys = await pendingOutputKeysForStyle(styleId);
  if (variantKeys.length === 0) return settle({ enqueued: false, reason: "nothing_pending" });

  const { jobId } = await enqueueGenerationJob({ styleId, triggerSource, variantKeys });
  return settle({ enqueued: true, jobId, variantKeys });
}

// Record that this style has been evaluated against `version` of its spec's
// output set. Fail-soft and guarded: the column is additive, so a pre-db:deploy
// deployment must degrade to "the version gap never closes" (the sweep re-checks
// and finds nothing_pending — wasteful but correct) rather than throwing the
// whole sweep. Never moves the stamp backwards.
async function stampOutputsChecked(styleId: string, version: number | null): Promise<void> {
  if (version === null) return; // column not deployed — nothing to record
  try {
    await db.style.updateMany({
      where: { id: styleId, outputsCheckedVersion: { lt: version } },
      data: { outputsCheckedVersion: version },
    });
  } catch {
    // column not deployed yet — nothing to record
  }
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

  const overFetch = Math.max(limit, 1) * 5;
  const poWindow = minPo !== null ? [{ poSeq: { gte: minPo } }, { poSeq: null }] : null;

  // Candidate class 1 — pre-generation styles on an active ProdSpec with no job
  // already in flight. Over-fetch: many will have nothing pending (already
  // generated) and get skipped by the per-style gate below.
  const preGeneration = await db.style.findMany({
    where: {
      prodSpecId: { not: null },
      prodSpec: { is: { active: true } },
      status: { in: ["PENDING", "READY"] },
      jobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } },
      ...(poWindow ? { OR: poWindow } : {}),
    },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
    take: overFetch,
  });

  // Candidate class 2 — already-generated styles whose spec has DECLARED A NEW
  // OUTPUT since they were last checked. Class 1 can never see these: the runner
  // moves a style to AWAITING_REVIEW on its first successful render, and it
  // never returns to PENDING/READY, so without this arm an output added to a
  // spec reaches only its never-generated styles and silently skips the rest.
  //
  // Prisma can't compare two columns, so this resolves the handful of active
  // specs first and asks per-spec ("styles of spec X below version N") — an
  // index scan on (prodSpecId, outputsCheckedVersion). Only specs that have
  // actually gained an output (outputsVersion > 0) are queried, so on a book
  // where nobody has edited a spec this costs one cheap query and nothing else.
  const versionGap = await findVersionGapStyles(overFetch, poWindow);

  // Class 1 first: a style waiting for its FIRST outputs is more urgent than one
  // topping up an extra document. Deduped — a style can qualify under both.
  const seen = new Set<string>();
  const candidates = [...preGeneration, ...versionGap].filter((c) =>
    seen.has(c.id) ? false : (seen.add(c.id), true),
  );

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

// Styles whose spec declares outputs they've never been evaluated for. Two
// queries regardless of book size: one for the active specs that have gained an
// output, one OR'd lookup across them.
//
// Fail-soft on the whole thing: the two columns are additive, so before
// db:deploy this returns nothing and the sweep behaves exactly as it did — the
// new candidate class simply doesn't exist yet.
async function findVersionGapStyles(
  take: number,
  poWindow: Array<Record<string, unknown>> | null,
): Promise<Array<{ id: string }>> {
  try {
    const specs = await db.prodSpec.findMany({
      where: { active: true, outputsVersion: { gt: 0 } },
      select: { id: true, outputsVersion: true },
    });
    if (specs.length === 0) return [];

    return await db.style.findMany({
      where: {
        archivedAt: null,
        deletedAt: null,
        jobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } },
        ...(poWindow ? { OR: poWindow } : {}),
        // AND-ed alongside the PO window above (Prisma merges the sibling `OR`
        // with this nested one via AND), so a parked style stays parked.
        AND: {
          OR: specs.map((s) => ({
            prodSpecId: s.id,
            outputsCheckedVersion: { lt: s.outputsVersion },
          })),
        },
      },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take,
    });
  } catch {
    // outputsVersion / outputsCheckedVersion not deployed yet.
    return [];
  }
}
