import { db, type DbClient } from "@/lib/db";
import type { TriggerSource } from "@/generated/prisma/enums";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { getAutoGenerateEnabled, getGenerationMinPo } from "@/lib/settings/app-settings";
import { pendingOutputKeysForStyle } from "@/lib/styles/output-readiness";
import { HAS_PO_NUMBER_WHERE, hasPoNumber } from "@/lib/styles/active-filter";
import { enqueueGenerationJob } from "./enqueue";
import { decideCoverRun, MAX_GEN_ATTEMPTS, type CoverRunSkip } from "./cover-run-gate";

// =====================================================
// Auto-generation gate + backlog sweep.
//
// Single source of truth for "this style has ready, ungenerated outputs —
// generate them now, no manual click?". Shared by the PO→EAN resolve handoff
// (one style at a time) and the periodic backlog sweep (many styles per tick),
// so the two can never drift.
// =====================================================

// FAILED generation jobs before the auto-paths give up — see cover-run-gate.ts.
export { MAX_GEN_ATTEMPTS } from "./cover-run-gate";

export type StyleGenSkip =
  | "auto_off"
  | "no_po"
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
//   2. PO number ("Navision Task") present — without one the style hasn't
//      entered the flow at all, so it neither lists (#290) nor generates.
//   3. ProdSpec ACTIVE — inactive scaffolds never auto-generate.
//   4. in-flight guard — one QUEUED/RUNNING job at a time per style.
//   5. float cap — a style with ≥ MAX_GEN_ATTEMPTS FAILED jobs is left for a
//      human (a manual re-run that succeeds clears it).
//   6. pendingOutputKeysForStyle — ready outputs MINUS those already generated
//      (a non-FAILED asset). REJECTED / AWAITING_REVIEW / APPROVED outputs are
//      therefore never redone; only never-succeeded ones remain. This is where
//      "don't auto-regenerate a rejected output" lives.
//   7. cover run — nothing to generate, but a cover-only style with no cover
//      yet still gets one run for its cover (maybeEnqueueCoverRun below).
export async function maybeEnqueueStyleGeneration(
  styleId: string,
  triggerSource: TriggerSource,
  opts: { autoGenerateEnabled?: boolean } = {},
): Promise<StyleGenDecision> {
  const autoOn = opts.autoGenerateEnabled ?? (await getAutoGenerateEnabled());
  if (!autoOn) return { enqueued: false, reason: "auto_off" };

  const style = await db.style.findUnique({
    where: { id: styleId },
    // poNumber rides along in the query that was already being made for
    // prodSpec.active — the PO gate costs nothing extra here.
    select: { poNumber: true, prodSpec: { select: { active: true } } },
  });
  // Checked BEFORE enqueueGenerationJob would throw, so the sweep reports
  // `no_po` on /automation instead of dying on a tick.
  if (!hasPoNumber(style?.poNumber)) return { enqueued: false, reason: "no_po" };
  if (!style?.prodSpec?.active) return { enqueued: false, reason: "prodspec_inactive" };

  const inflight = await db.job.count({
    where: { styleId, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inflight > 0) return { enqueued: false, reason: "in_flight" };

  const failures = await db.job.count({ where: { styleId, status: "FAILED" } });
  const variantKeys = failures >= MAX_GEN_ATTEMPTS ? [] : await pendingOutputKeysForStyle(styleId);
  if (variantKeys.length > 0) {
    const { jobId } = await enqueueGenerationJob({ styleId, triggerSource, variantKeys });
    return { enqueued: true, jobId, variantKeys };
  }

  // No output to generate — but a cover-only style that has never had its
  // cover built still needs one run. Its own float count (failures since the
  // spec last changed) so NO_OUTPUTS failures from before the tick don't
  // strand it.
  const cover = await maybeEnqueueCoverRun(styleId, triggerSource, {
    requireCoverOnly: true,
    autoGenerateEnabled: true,
  });
  if (cover.enqueued) return { enqueued: true, jobId: cover.jobId, variantKeys: [] };
  return { enqueued: false, reason: failures >= MAX_GEN_ATTEMPTS ? "floated" : "nothing_pending" };
}

// =====================================================
// Cover-run failsafe.
//
// Every generation path above is driven by OUTPUTS: a style is enqueued when
// one of its outputs is ready and ungenerated. A cover-only spec has none, so
// none of them ever fire for it — and the cover is only ever built BY a
// generation run. The manual-packaging flow can't fill the gap either: its
// cover rebuild (refreshStyleCoverAsset) refreshes an EXISTING cover in place
// and answers "no-cover" for a style that never had one. Net effect: a
// cover-only style sat with no cover until somebody pressed Re-run.
//
// This is the one gate that answers "does this style still need a run just to
// get its first cover?". Used by the backlog sweep, the Monday ingest paths
// (requireCoverOnly — a cover-only spec is the only case where "nothing
// pending" can still mean "nothing built"), and the cover-regen drain when a
// manual packaging change or approval lands on a style with no cover (any
// spec — a human action on the style is the demand).
//
// The run it enqueues is a plain full run (no scope): the runner renders every
// ready enabled output (none, for a pure cover-only spec) and always builds
// the cover. Once that cover exists the gate closes for good (has_cover), so
// it can't loop.
// =====================================================

// A cover from any non-FAILED job — the same rule getCurrentCoverAsset (the
// cover the refresh path rebuilds) uses.
export async function styleHasCover(styleId: string, client: DbClient = db): Promise<boolean> {
  const n = await client.jobAsset.count({
    where: { variantKey: COVER_VARIANT_KEY, job: { styleId, status: { not: "FAILED" } } },
  });
  return n > 0;
}

export async function maybeEnqueueCoverRun(
  styleId: string,
  triggerSource: TriggerSource,
  opts: { requireCoverOnly: boolean; autoGenerateEnabled?: boolean; client?: DbClient },
): Promise<{ enqueued: true; jobId: string } | { enqueued: false; reason: CoverRunSkip }> {
  const client = opts.client ?? db;
  const style = await client.style.findUnique({
    where: { id: styleId },
    select: {
      poNumber: true,
      prodSpec: { select: { active: true, coverOnly: true, updatedAt: true } },
    },
  });
  const prodSpec = style?.prodSpec ?? null;
  // Cheap exit before the counts: the sweep and the bulk Monday sync ask this
  // of every style with nothing pending, and nearly none are cover-only.
  if (opts.requireCoverOnly && prodSpec?.coverOnly !== true) {
    return { enqueued: false, reason: "not_cover_only" };
  }
  const [autoGenerateEnabled, inflight, recentFailures, hasCover] = await Promise.all([
    opts.autoGenerateEnabled ?? getAutoGenerateEnabled(),
    client.job.count({ where: { styleId, status: { in: ["QUEUED", "RUNNING"] } } }),
    prodSpec
      ? client.job.count({ where: { styleId, status: "FAILED", createdAt: { gte: prodSpec.updatedAt } } })
      : Promise.resolve(0),
    styleHasCover(styleId, client),
  ]);
  const skip = decideCoverRun({
    hasPo: hasPoNumber(style?.poNumber),
    prodSpec,
    requireCoverOnly: opts.requireCoverOnly,
    autoGenerateEnabled,
    inflight,
    recentFailures,
    hasCover,
  });
  if (skip) return { enqueued: false, reason: skip };

  const { jobId } = await enqueueGenerationJob({ styleId, triggerSource, client });
  await client.log.create({
    data: {
      jobId,
      level: "INFO",
      message:
        "cover run — this style has no cover page yet" +
        (prodSpec?.coverOnly === true ? " (cover-only spec)" : " (packaging changed on the style)"),
    },
  });
  return { enqueued: true, jobId };
}

// Cover-only styles that have never had a cover built, for the backlog sweep.
// A separate query from the output candidates because those are ordered by
// updatedAt over the whole estate and capped — a quiet cover-only style would
// never make it into that window. Small by construction: once its cover
// exists, a style drops out of this set for good.
async function coverOnlyCandidates(limit: number, minPo: number | null): Promise<string[]> {
  const rows = await db.style.findMany({
    where: {
      ...HAS_PO_NUMBER_WHERE,
      prodSpec: { is: { active: true, coverOnly: true } },
      jobs: {
        none: {
          OR: [
            { status: { in: ["QUEUED", "RUNNING"] } },
            { status: { not: "FAILED" }, assets: { some: { variantKey: COVER_VARIANT_KEY } } },
          ],
        },
      },
      ...(minPo !== null ? { OR: [{ poSeq: { gte: minPo } }, { poSeq: null }] } : {}),
    },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
    take: Math.max(limit, 1) * 5,
  });
  return rows.map((r) => r.id);
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
  no_po: 0,
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
  // getGenerationMinPo). null = no cutoff (whole backlog).
  //
  // "poSeq IS NULL" is still admitted by the cutoff, and that is deliberate: it
  // means a PO number that didn't PARSE onto the numeric timeline (an oddly
  // formatted cell), not an absent one. A style with no PO at all is now
  // excluded a line below by HAS_PO_NUMBER_WHERE — a different question, gated
  // separately, so an unparseable-but-present PO keeps generating as before.
  const minPo = await getGenerationMinPo();

  // Cheap prefilter: pre-generation styles that carry a PO number, sit on an
  // active ProdSpec and have no job already in flight. Over-fetch — many
  // candidates will have nothing pending (already generated) and get skipped by
  // the per-style gate below.
  //
  // The PO clause is the list's own HAS_PO_NUMBER_WHERE, so the sweep can't
  // start generating rows that /styles hides. maybeEnqueueStyleGeneration
  // re-checks it per style (trim-aware) — this is only here so a backlog of
  // PO-less placeholders can't eat the bounded candidate window.
  const candidates = await db.style.findMany({
    where: {
      ...HAS_PO_NUMBER_WHERE,
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

  // Cover-only styles still waiting for their first cover. They have no output
  // to make them "ready", so the window above can't be relied on to find them.
  const seen = new Set(candidates.map((c) => c.id));
  for (const id of await coverOnlyCandidates(limit, minPo)) {
    if (summary.enqueued >= limit) break;
    if (seen.has(id)) continue;
    summary.checked += 1;
    const decision = await maybeEnqueueCoverRun(id, "CRON_SWEEP", {
      requireCoverOnly: true,
      autoGenerateEnabled: true,
    });
    if (decision.enqueued) {
      summary.enqueued += 1;
      summary.styleIds.push(id);
      summary.jobIds.push(decision.jobId);
    } else if (decision.reason === "floated" || decision.reason === "in_flight" || decision.reason === "no_po") {
      summary.skips[decision.reason] += 1;
    } else {
      summary.skips.nothing_pending += 1;
    }
  }
  return summary;
}
