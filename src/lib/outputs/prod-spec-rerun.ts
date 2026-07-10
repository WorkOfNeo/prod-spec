import { db } from "@/lib/db";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { layoutIdFromVariantKey } from "@/lib/output-layouts/variant-keys";
import { outputReadinessForStyle, type ReadinessStyle } from "@/lib/styles/output-readiness";
import { loadIgnoredOutputKeysByStyle } from "@/lib/outputs/output-ignores";
import type { RunnableStyle } from "@/lib/queue/bulk-run";
import { triggerKind, type TriggerKind } from "@/lib/queue/trigger-labels";

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
  poNumber: string | null;
  // Ready outputs with no asset yet (newly added / never generated).
  missing: number;
  // Ready outputs whose latest asset was REJECTED in review.
  rejected: number;
  // Human names of the rejected outputs (variant names) — powers the
  // "approve these PDFs" confirm dialog on the Fully-approved toggle.
  rejectedNames: string[];
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

export async function computeProdSpecRerunPlan(
  prodSpecId: string,
  // rejectedOnly scopes the plan to previously-REJECTED outputs only (drop the
  // new/missing sweep). The "Fully approved" toggle's approve-and-rerun flow
  // uses this so the run regenerates exactly the PDFs the confirm dialog lists.
  options: { rejectedOnly?: boolean } = {},
): Promise<ProdSpecRerunPlan> {
  const rejectedOnly = options.rejectedOnly === true;
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
    const rejectedNames: string[] = [];
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
        // new / missing — skipped entirely in rejectedOnly mode.
        if (!rejectedOnly) {
          variantKeys.push(o.variantKey);
          missingN++;
        }
      } else if (hasRejected.has(b)) {
        variantKeys.push(o.variantKey); // previously rejected
        rejectedN++;
        rejectedNames.push(o.name);
      }
      // generated & not rejected (approved / awaiting review) → leave it.
    }

    if (variantKeys.length === 0) continue;
    toRerun.push({ id: c.id, prodSpecId: c.prodSpecId, variantKeys });
    if (missingN > 0) withMissing++;
    if (rejectedN > 0) withRejected++;
    if (sample.length < SAMPLE_CAP) {
      sample.push({
        id: c.id,
        name: c.name,
        poNumber: c.poNumber,
        missing: missingN,
        rejected: rejectedN,
        rejectedNames,
      });
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

// =====================================================
// Per-ProdSpec run list — EVERY active style on the spec (not just the
// already-generated ones computeProdSpecRerunPlan reruns over), each with the
// scoped set of outputs a run would regenerate, a last-run stamp, and whether
// that last run was automated or manual. Backs the run-list table in the
// ProdSpec editor's Outputs tab: run all, or run one.
//
// The scoped set is identical to the bulk plan — new/missing + previously
// rejected READY outputs; approved and awaiting-review outputs are left alone.
// A never-generated style's ready outputs are all "missing", so running it
// generates them for the first time.
// =====================================================

// Select for the run list — the readiness inputs plus the style's own status
// (shown as a pill in the table). Extends the shared candidate shape.
const RUN_LIST_SELECT = {
  ...CANDIDATE_SELECT,
  status: true,
} as const;

// The newest job for a style, distilled for the "Last run" column.
export type StyleLastRun = {
  // finishedAt ?? startedAt ?? createdAt, as an ISO string for the client.
  at: string;
  // JobStatus of that job (QUEUED / RUNNING / AWAITING_REVIEW / APPROVED / …).
  status: string;
  triggerSource: string;
  kind: TriggerKind;
};

// One row in the run list — one active style on the spec.
export type StyleRunRow = {
  id: string;
  name: string;
  poNumber: string | null;
  // The style's own workflow status (StyleStatus).
  status: string;
  // Ready, non-excluded outputs total — the denominator behind the state text
  // ("up to date" vs "awaiting data").
  readyCount: number;
  // Scoped rerun for this style: new/missing + previously-rejected ready
  // outputs. Empty ⇒ nothing to regenerate (all approved / awaiting review, or
  // no ready outputs at all). The per-row Run button posts exactly these keys.
  variantKeys: string[];
  missing: number;
  rejected: number;
  // Ready outputs whose Output Builder layout was EDITED after this style's
  // current asset was generated (layout `updatedAt` > asset `createdAt`), and
  // whose latest asset is NOT approved (awaiting review). Folded into
  // variantKeys so a manual run regenerates them. Approved-but-changed outputs
  // are counted in `changedApproved` instead and left OUT of the run set.
  changed: number;
  // Ready outputs whose layout changed since generation but whose latest asset
  // is APPROVED — surfaced as a flag only, never auto-added to the run set (a
  // manual, deliberate rerun is required so approved work isn't blasted back
  // into review). Kept separate from `changed` for exactly that reason.
  changedApproved: number;
  // A QUEUED/RUNNING job is already in flight — the row can't be re-run yet and
  // it's excluded from "Run all". `queueState` says which: "queued" (accepted,
  // waiting for the runner) vs "running" (actively rendering); null when idle.
  inFlight: boolean;
  queueState: "queued" | "running" | null;
  // Newest job for this style, or null if it never ran.
  lastRun: StyleLastRun | null;
};

export type ProdSpecStyleRunList = {
  prodSpecActive: boolean;
  // Every active style on the spec.
  totalStyles: number;
  // Of those, how many have generated ≥1 output before.
  generatedStyles: number;
  // Rows with ≥1 output to run and no in-flight job — the "Run all" universe.
  toRerun: number;
  withMissing: number;
  withRejected: number;
  // Runnable styles that include ≥1 changed (non-approved) output.
  withChanged: number;
  // Styles that have ≥1 approved output on an outdated layout — the "flagged,
  // won't auto-run" bucket, surfaced as a spec-level notice.
  changedApprovedStyles: number;
  rows: StyleRunRow[];
};

const emptyRunList = (active: boolean): ProdSpecStyleRunList => ({
  prodSpecActive: active,
  totalStyles: 0,
  generatedStyles: 0,
  toRerun: 0,
  withMissing: 0,
  withRejected: 0,
  withChanged: 0,
  changedApprovedStyles: 0,
  rows: [],
});

export async function listProdSpecStyleRuns(prodSpecId: string): Promise<ProdSpecStyleRunList> {
  const spec = await db.prodSpec.findUnique({
    where: { id: prodSpecId },
    select: { active: true },
  });
  if (!spec) return emptyRunList(false);

  // Output Builder layouts (layout:<id>) must be registered before the
  // readiness walk resolves them — same rule as the bulk plan.
  await ensureLayoutVariantsLoaded();

  // EVERY active style on this spec — including never-generated ones (they show
  // as "never run"; running one generates all its ready outputs). Newest first
  // so the operator sees recently-touched styles at the top.
  const candidates = await db.style.findMany({
    where: { prodSpecId, archivedAt: null, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    select: RUN_LIST_SELECT,
  });
  if (candidates.length === 0) return emptyRunList(spec.active);

  const styleIds = candidates.map((c) => c.id);

  // Latest asset per (style, full variantKey) across non-FAILED jobs, newest
  // job first — identical to the bulk plan so "current decision" agrees with
  // the review surfaces. Rolled up to base below.
  const assets = await db.jobAsset.findMany({
    where: {
      job: { styleId: { in: styleIds }, status: { not: "FAILED" } },
      variantKey: { not: null },
    },
    orderBy: { job: { createdAt: "desc" } },
    select: {
      variantKey: true,
      reviewStatus: true,
      // Generation time — compared against the layout's last-edit time to flag
      // outputs whose design changed since this asset was produced.
      createdAt: true,
      job: { select: { styleId: true } },
    },
  });
  type LatestAsset = { status: "PENDING_REVIEW" | "APPROVED" | "REJECTED"; at: Date };
  const latestByStyle = new Map<string, Map<string, LatestAsset>>();
  for (const a of assets) {
    if (!a.variantKey) continue;
    let m = latestByStyle.get(a.job.styleId);
    if (!m) {
      m = new Map();
      latestByStyle.set(a.job.styleId, m);
    }
    if (!m.has(a.variantKey)) m.set(a.variantKey, { status: a.reviewStatus, at: a.createdAt });
  }

  // Published Output Builder layouts → last-edit time, keyed by layout id.
  // Editing a published layout takes effect on future renders immediately and
  // bumps `updatedAt` (see the layout PATCH route), so `updatedAt` is the
  // accurate "this output's design last changed" signal. Only layout outputs
  // carry this — coded templates have no per-output change stamp (out of scope).
  const layoutRows = await db.outputLayout.findMany({
    where: { status: "PUBLISHED" },
    select: { id: true, updatedAt: true },
  });
  const layoutUpdatedById = new Map<string, Date>(layoutRows.map((l) => [l.id, l.updatedAt]));

  // Styles with a QUEUED/RUNNING job — shown as Queued/Generating, not runnable.
  const inflight = await db.job.findMany({
    where: { styleId: { in: styleIds }, status: { in: ["QUEUED", "RUNNING"] } },
    select: { styleId: true, status: true },
    distinct: ["styleId"],
  });
  // styleId → in-flight job status. At most one in-flight job per style (the
  // enqueue paths refuse to double-enqueue), so distinct-by-style is exact.
  const inflightByStyle = new Map<string, "QUEUED" | "RUNNING">();
  for (const j of inflight) inflightByStyle.set(j.styleId, j.status as "QUEUED" | "RUNNING");

  // Newest job per style (any status) → the "Last run" stamp + trigger. Fetched
  // newest-first; first row seen per style wins (same reduce as the asset
  // rollup above, guaranteed-correct without relying on DISTINCT ON ordering).
  const jobRows = await db.job.findMany({
    where: { styleId: { in: styleIds } },
    orderBy: { createdAt: "desc" },
    select: {
      styleId: true,
      status: true,
      triggerSource: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  const lastJobByStyle = new Map<string, (typeof jobRows)[number]>();
  for (const j of jobRows) {
    if (!lastJobByStyle.has(j.styleId)) lastJobByStyle.set(j.styleId, j);
  }

  // Per-style operator ignores — an ignored output must not count as "missing"
  // (it would re-enqueue on every run and never render).
  const ignoredByStyle = await loadIgnoredOutputKeysByStyle(styleIds);

  const rows: StyleRunRow[] = [];
  let generatedStyles = 0;
  let toRerun = 0;
  let withMissing = 0;
  let withRejected = 0;
  let withChanged = 0;
  let changedApprovedStyles = 0;

  for (const c of candidates) {
    // Roll latest-per-fullKey assets up to base (see computeProdSpecRerunPlan).
    // Beyond has-asset / has-rejected we also track whether any doc is still
    // awaiting review (hasPending) and the newest asset time per base (to
    // compare against the layout's last-edit time for the "changed" flag).
    const hasAsset = new Set<string>();
    const hasRejected = new Set<string>();
    const hasPending = new Set<string>();
    const newestAtByBase = new Map<string, number>();
    const fullKeys = latestByStyle.get(c.id);
    if (fullKeys) {
      for (const [fk, a] of fullKeys) {
        const b = base(fk);
        hasAsset.add(b);
        if (a.status === "REJECTED") hasRejected.add(b);
        if (a.status === "PENDING_REVIEW") hasPending.add(b);
        const t = a.at.getTime();
        const prev = newestAtByBase.get(b);
        if (prev === undefined || t > prev) newestAtByBase.set(b, t);
      }
    }
    if (hasAsset.size > 0) generatedStyles++;

    // An output "changed" when its published layout was edited after this
    // style's current asset for it was generated. Layout outputs only.
    const isChanged = (b: string): boolean => {
      const layoutId = layoutIdFromVariantKey(b);
      if (!layoutId) return false;
      const updatedAt = layoutUpdatedById.get(layoutId);
      const generatedAt = newestAtByBase.get(b);
      return updatedAt != null && generatedAt != null && updatedAt.getTime() > generatedAt;
    };

    const variantKeys: string[] = [];
    let missingN = 0;
    let rejectedN = 0;
    let changedN = 0;
    let changedApprovedN = 0;
    let readyCount = 0;
    for (const o of outputReadinessForStyle(
      c as ReadinessStyle,
      undefined,
      undefined,
      ignoredByStyle.get(c.id),
    )) {
      if (!o.ready || o.excluded) continue;
      readyCount++;
      const b = base(o.variantKey);
      if (!hasAsset.has(b)) {
        variantKeys.push(o.variantKey); // new / missing
        missingN++;
      } else if (hasRejected.has(b)) {
        variantKeys.push(o.variantKey); // previously rejected
        rejectedN++;
      } else if (isChanged(b)) {
        // Generated & not rejected, but the layout changed since. Awaiting
        // review → fold into the run set; Approved → flag only, left out so
        // approved work isn't blasted back into review without a deliberate run.
        if (hasPending.has(b)) {
          variantKeys.push(o.variantKey);
          changedN++;
        } else {
          changedApprovedN++;
        }
      }
      // generated, not rejected, unchanged (approved / awaiting up-to-date) → leave.
    }

    const inflightStatus = inflightByStyle.get(c.id);
    const isInflight = inflightStatus != null;
    const queueState = inflightStatus === "RUNNING" ? "running" : inflightStatus === "QUEUED" ? "queued" : null;
    // "Run all" mirrors what the button will actually enqueue: runnable outputs
    // and not already in flight.
    if (variantKeys.length > 0 && !isInflight) {
      toRerun++;
      if (missingN > 0) withMissing++;
      if (rejectedN > 0) withRejected++;
      if (changedN > 0) withChanged++;
    }
    if (!isInflight && changedApprovedN > 0) changedApprovedStyles++;

    const lj = lastJobByStyle.get(c.id);
    rows.push({
      id: c.id,
      name: c.name,
      poNumber: c.poNumber,
      status: c.status,
      readyCount,
      variantKeys,
      missing: missingN,
      rejected: rejectedN,
      changed: changedN,
      changedApproved: changedApprovedN,
      inFlight: isInflight,
      queueState,
      lastRun: lj
        ? {
            at: (lj.finishedAt ?? lj.startedAt ?? lj.createdAt).toISOString(),
            status: lj.status,
            triggerSource: lj.triggerSource,
            kind: triggerKind(lj.triggerSource),
          }
        : null,
    });
  }

  return {
    prodSpecActive: spec.active,
    totalStyles: candidates.length,
    generatedStyles,
    toRerun,
    withMissing,
    withRejected,
    withChanged,
    changedApprovedStyles,
    rows,
  };
}
