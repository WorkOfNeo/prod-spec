import { db } from "@/lib/db";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { outputReadinessForStyle, type ReadinessStyle } from "@/lib/styles/output-readiness";
import { loadIgnoredOutputKeysByStyle } from "@/lib/outputs/output-ignores";
import type { RunnableStyle } from "@/lib/queue/bulk-run";

// =====================================================
// Prod-spec rerun plan — after an admin swaps a ProdSpec's outputs, decide
// which of its styles to regenerate and EXACTLY which outputs per style:
//
//   ready outputs that are NEW/MISSING (never generated) OR currently REJECTED.
//
// Approved and awaiting-review outputs are deliberately left alone (no
// re-review churn — a spec with hundreds of styles mustn't blast every
// approved output back into the queue). Computed in 3 batched queries so it
// scales like the /styles "Run all outputs" path rather than N per-style reads.
// =====================================================

// One style that needs a rerun, with a per-bucket breakdown for the UI.
export type AffectedStyle = {
  id: string;
  name: string;
  // Ready outputs with no asset yet (newly added / never generated).
  missing: number;
  // Ready outputs whose latest asset was REJECTED in review.
  rejected: number;
};

export type ProdSpecRerunPlan = {
  prodSpecActive: boolean;
  // Styles attached to the spec that have generated ≥1 output before — the
  // "already-generated" universe we rerun within (never-generated PENDING
  // styles awaiting data are out of scope by the operator's choice).
  generatedStyles: number;
  // Styles that will actually rerun (≥1 missing or rejected ready output),
  // each scoped to the variant keys to regenerate.
  toRerun: RunnableStyle[];
  withMissing: number;
  withRejected: number;
  // Capped, display-friendly slice for the "see affected styles" list.
  sample: AffectedStyle[];
};

// Keep the affected-styles payload bounded — a spec can have hundreds of
// styles; the UI shows this slice plus an "and N more" tail.
const SAMPLE_CAP = 100;

const base = (variantKey: string) => variantKey.split("#")[0];

// Candidate select mirrors outputReadinessForStyle's ReadinessStyle shape so
// the readiness here matches the real render (same as the /styles route).
const CANDIDATE_SELECT = {
  id: true,
  name: true,
  prodSpecId: true,
  rawData: true,
  poNumber: true,
  cartonEan: true,
  supplier: { select: { country: true } },
  eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true } },
  customer: { select: { config: true } },
  prodSpec: { select: { outputs: true, columnMapping: true } },
} as const;

const empty = (active: boolean): ProdSpecRerunPlan => ({
  prodSpecActive: active,
  generatedStyles: 0,
  toRerun: [],
  withMissing: 0,
  withRejected: 0,
  sample: [],
});

export async function computeProdSpecRerunPlan(prodSpecId: string): Promise<ProdSpecRerunPlan> {
  const spec = await db.prodSpec.findUnique({
    where: { id: prodSpecId },
    select: { active: true },
  });
  if (!spec) return empty(false);

  // Output Builder layouts (layout:<id>) must be in the registry before the
  // readiness walk resolves them — the one architectural rule for layout keys.
  await ensureLayoutVariantsLoaded();

  // Already-generated styles on this spec (≥1 output asset ever). Archived /
  // deleted styles are excluded — we never regenerate retired styles.
  const candidates = await db.style.findMany({
    where: {
      prodSpecId,
      archivedAt: null,
      deletedAt: null,
      jobs: { some: { assets: { some: {} } } },
    },
    select: CANDIDATE_SELECT,
  });
  if (candidates.length === 0) return empty(spec.active);

  const styleIds = candidates.map((c) => c.id);

  // Latest asset per (style, full variantKey) across non-FAILED jobs, newest
  // job first — mirrors getCurrentOutputsForStyle so "current decision" agrees
  // with the review surfaces. Rolled up to base below.
  const assets = await db.jobAsset.findMany({
    where: {
      job: { styleId: { in: styleIds }, status: { not: "FAILED" } },
      variantKey: { not: null },
    },
    orderBy: { job: { createdAt: "desc" } },
    select: { variantKey: true, reviewStatus: true, job: { select: { styleId: true } } },
  });
  // styleId → fullVariantKey → latest reviewStatus (first seen wins = newest).
  const latestByStyle = new Map<string, Map<string, "PENDING_REVIEW" | "APPROVED" | "REJECTED">>();
  for (const a of assets) {
    if (!a.variantKey) continue;
    let m = latestByStyle.get(a.job.styleId);
    if (!m) {
      m = new Map();
      latestByStyle.set(a.job.styleId, m);
    }
    if (!m.has(a.variantKey)) m.set(a.variantKey, a.reviewStatus);
  }

  // Styles with a QUEUED/RUNNING job — skip entirely (don't double-enqueue).
  const inflight = await db.job.findMany({
    where: { styleId: { in: styleIds }, status: { in: ["QUEUED", "RUNNING"] } },
    select: { styleId: true },
    distinct: ["styleId"],
  });
  const inflightSet = new Set(inflight.map((j) => j.styleId));

  // Per-style operator ignores — an ignored output must not count as "missing"
  // (it would re-enqueue on every rerun and never render).
  const ignoredByStyle = await loadIgnoredOutputKeysByStyle(styleIds);

  const toRerun: RunnableStyle[] = [];
  const sample: AffectedStyle[] = [];
  let withMissing = 0;
  let withRejected = 0;

  for (const c of candidates) {
    if (inflightSet.has(c.id)) continue;

    // Roll the latest-per-fullKey assets up to base: a base "has an asset" if
    // any of its docs generated; "has a rejected doc" if any latest doc is
    // REJECTED (a multi-doc output regenerates wholesale if any size rejected).
    const hasAsset = new Set<string>();
    const hasRejected = new Set<string>();
    const fullKeys = latestByStyle.get(c.id);
    if (fullKeys) {
      for (const [fk, status] of fullKeys) {
        const b = base(fk);
        hasAsset.add(b);
        if (status === "REJECTED") hasRejected.add(b);
      }
    }

    const variantKeys: string[] = [];
    let missingN = 0;
    let rejectedN = 0;
    for (const o of outputReadinessForStyle(
      c as ReadinessStyle,
      undefined,
      undefined,
      ignoredByStyle.get(c.id),
    )) {
      if (!o.ready || o.excluded) continue;
      const b = base(o.variantKey);
      if (!hasAsset.has(b)) {
        variantKeys.push(o.variantKey); // new / missing
        missingN++;
      } else if (hasRejected.has(b)) {
        variantKeys.push(o.variantKey); // previously rejected
        rejectedN++;
      }
      // generated & not rejected (approved / awaiting review) → leave it.
    }

    if (variantKeys.length === 0) continue;
    toRerun.push({ id: c.id, prodSpecId: c.prodSpecId, variantKeys });
    if (missingN > 0) withMissing++;
    if (rejectedN > 0) withRejected++;
    if (sample.length < SAMPLE_CAP) {
      sample.push({ id: c.id, name: c.name, missing: missingN, rejected: rejectedN });
    }
  }

  return {
    prodSpecActive: spec.active,
    generatedStyles: candidates.length,
    toRerun,
    withMissing,
    withRejected,
    sample,
  };
}
