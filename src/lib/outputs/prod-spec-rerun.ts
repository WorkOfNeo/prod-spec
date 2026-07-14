import { db } from "@/lib/db";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { outputReadinessForStyle, type ReadinessStyle } from "@/lib/styles/output-readiness";
import { loadIgnoredOutputKeysByStyle } from "@/lib/outputs/output-ignores";
import { outputConfigKey } from "@/lib/outputs/output-config-key";
import { getVariant } from "@/lib/pdf/template-registry";
import { classifyOutput, type BaseAssetState, type OutputBucket } from "@/lib/outputs/rerun-buckets";
import { parseProdSpecOutputs, type ProdSpecOutput } from "@/lib/prod-spec/config";
import type { RunnableStyle } from "@/lib/queue/bulk-run";
import { triggerKind, type TriggerKind } from "@/lib/queue/trigger-labels";

// =====================================================
// Prod-spec rerun plan — after an admin swaps or edits a ProdSpec's outputs,
// decide which of its styles to regenerate and EXACTLY which outputs per style:
//
//   every ready output that isn't APPROVED — NEW/MISSING (never generated),
//   REJECTED, or still AWAITING REVIEW (pending). "Run all" runs them all.
//
// APPROVED outputs are the only skip — an approved PDF is left in place (the
// operator's explicit choice), even when its config changed. Among the pending
// outputs we still flag "changed" (config edited since render) as a display
// highlight, but changed and plain-pending both run. Computed in a handful of
// batched queries so it scales like the /styles "Run all outputs" path rather
// than N per-style reads.
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
  // Ready outputs still awaiting review whose config was edited since render.
  changed: number;
  // Ready outputs awaiting review, config unchanged (a plain pending re-run).
  pending: number;
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
  // Styles that will actually rerun (≥1 not-approved ready output), each scoped
  // to the variant keys to regenerate.
  toRerun: RunnableStyle[];
  withMissing: number;
  withRejected: number;
  withChanged: number;
  withPending: number;
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

// =====================================================
// Shared asset rollup — latest asset per (style, base variantKey), reduced to
// the three facts the rerun buckets need: does the base have any asset, is its
// latest decision REJECTED, is it still awaiting review, and the config
// fingerprint it was rendered with. Both the bulk plan and the run list read
// through this so "current decision" agrees with the review surfaces.
// =====================================================

async function loadLatestBaseStateByStyle(
  styleIds: string[],
): Promise<Map<string, Map<string, BaseAssetState>>> {
  const where = {
    job: { styleId: { in: styleIds }, status: { not: "FAILED" as const } },
    variantKey: { not: null },
  };
  const order = { job: { createdAt: "desc" as const } };

  type Row = {
    variantKey: string | null;
    reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
    outputConfigKey: string | null;
    outputContentVersion: number | null;
    job: { styleId: string };
  };
  let assets: Row[];
  try {
    assets = (await db.jobAsset.findMany({
      where,
      orderBy: order,
      select: {
        variantKey: true,
        reviewStatus: true,
        outputConfigKey: true,
        outputContentVersion: true,
        job: { select: { styleId: true } },
      },
    })) as Row[];
  } catch {
    // A fingerprint column not present yet (pre-db:deploy) — read without them.
    // Every key/version reads as null, so nothing is ever "changed" until the
    // migration lands (matches the runner's guarded eanResolveKey).
    const rows = await db.jobAsset.findMany({
      where,
      orderBy: order,
      select: { variantKey: true, reviewStatus: true, job: { select: { styleId: true } } },
    });
    assets = rows.map((r) => ({ ...r, outputConfigKey: null, outputContentVersion: null }));
  }

  // styleId → fullVariantKey → {latest status, key, version} (first seen wins).
  const latestFull = new Map<
    string,
    Map<string, { status: Row["reviewStatus"]; key: string | null; version: number | null }>
  >();
  for (const a of assets) {
    if (!a.variantKey) continue;
    let m = latestFull.get(a.job.styleId);
    if (!m) {
      m = new Map();
      latestFull.set(a.job.styleId, m);
    }
    if (!m.has(a.variantKey)) {
      m.set(a.variantKey, { status: a.reviewStatus, key: a.outputConfigKey, version: a.outputContentVersion });
    }
  }

  // Roll full keys up to base: a base "has an asset" if any doc generated; "has
  // a rejected doc" if any latest doc is REJECTED (a multi-doc output
  // regenerates wholesale if any size rejected); "has pending" if any latest
  // doc still awaits review. configKey / contentVersion = the newest doc's (docs
  // of one output share a config + layout version, so any is representative).
  const out = new Map<string, Map<string, BaseAssetState>>();
  for (const [styleId, fulls] of latestFull) {
    const byBase = new Map<string, BaseAssetState>();
    for (const [fk, { status, key, version }] of fulls) {
      const b = base(fk);
      let s = byBase.get(b);
      if (!s) {
        s = { hasAsset: false, hasRejected: false, hasPending: false, configKey: null, contentVersion: null };
        byBase.set(b, s);
      }
      s.hasAsset = true;
      if (status === "REJECTED") s.hasRejected = true;
      if (status === "PENDING_REVIEW") s.hasPending = true;
      if (s.configKey == null && key != null) s.configKey = key;
      if (s.contentVersion == null && version != null) s.contentVersion = version;
    }
    out.set(styleId, byBase);
  }
  return out;
}

// base variantKey → the output's current row-config fingerprint, from the spec.
function currentKeyByBase(outputs: ProdSpecOutput[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const o of outputs) m.set(base(o.variantKey), outputConfigKey(o));
  return m;
}

// base variantKey → the output's CURRENT layout content version (null for coded
// variants). Callers must have awaited ensureLayoutVariantsLoaded() first so the
// registry carries fresh versions.
function currentContentVersionByBase(outputs: ProdSpecOutput[]): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const o of outputs) m.set(base(o.variantKey), getVariant(o.variantKey)?.contentVersion ?? null);
  return m;
}

const empty = (active: boolean): ProdSpecRerunPlan => ({
  prodSpecActive: active,
  generatedStyles: 0,
  toRerun: [],
  withMissing: 0,
  withRejected: 0,
  withChanged: 0,
  withPending: 0,
  sample: [],
});

export async function computeProdSpecRerunPlan(
  prodSpecId: string,
  // rejectedOnly scopes the plan to previously-REJECTED outputs only (drop the
  // new/missing + changed sweep). The "Fully approved" toggle's approve-and-
  // rerun flow uses this so the run regenerates exactly the PDFs the confirm
  // dialog lists.
  options: { rejectedOnly?: boolean } = {},
): Promise<ProdSpecRerunPlan> {
  const rejectedOnly = options.rejectedOnly === true;
  const spec = await db.prodSpec.findUnique({
    where: { id: prodSpecId },
    select: { active: true, outputs: true },
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
  const specOutputs = safeOutputs(spec.outputs);
  const currentKeys = currentKeyByBase(specOutputs);
  const currentVersions = currentContentVersionByBase(specOutputs);
  const stateByStyle = await loadLatestBaseStateByStyle(styleIds);

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
  let withChanged = 0;
  let withPending = 0;

  for (const c of candidates) {
    if (inflightSet.has(c.id)) continue;

    const state = stateByStyle.get(c.id);
    const variantKeys: string[] = [];
    const rejectedNames: string[] = [];
    let missingN = 0;
    let rejectedN = 0;
    let changedN = 0;
    let pendingN = 0;
    for (const o of outputReadinessForStyle(
      c as ReadinessStyle,
      undefined,
      undefined,
      ignoredByStyle.get(c.id),
    )) {
      if (!o.ready || o.excluded) continue;
      const b = base(o.variantKey);
      const bucket = classifyOutput(state?.get(b), currentKeys.get(b) ?? null, currentVersions.get(b) ?? null);
      if (bucket === "rejected") {
        variantKeys.push(o.variantKey);
        rejectedN++;
        rejectedNames.push(o.name);
      } else if (bucket === "ok") {
        // approved → leave it.
      } else if (!rejectedOnly) {
        // missing / changed / pending — every not-approved output re-runs.
        variantKeys.push(o.variantKey);
        if (bucket === "missing") missingN++;
        else if (bucket === "changed") changedN++;
        else pendingN++;
      }
    }

    if (variantKeys.length === 0) continue;
    toRerun.push({ id: c.id, prodSpecId: c.prodSpecId, variantKeys });
    if (missingN > 0) withMissing++;
    if (rejectedN > 0) withRejected++;
    if (changedN > 0) withChanged++;
    if (pendingN > 0) withPending++;
    if (sample.length < SAMPLE_CAP) {
      sample.push({
        id: c.id,
        name: c.name,
        poNumber: c.poNumber,
        missing: missingN,
        rejected: rejectedN,
        changed: changedN,
        pending: pendingN,
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
    withChanged,
    withPending,
    sample,
  };
}

// =====================================================
// Per-ProdSpec run list — EVERY active style on the spec (not just the
// already-generated ones computeProdSpecRerunPlan reruns over), each with the
// scoped set of outputs a run would regenerate, a last-run stamp, and whether
// that last run was automated or manual. Backs the run-list table AND the
// per-output "Run all" buttons in the ProdSpec editor's Outputs tab.
//
// The scoped set is identical to the bulk plan — new/missing + previously
// rejected + changed READY outputs; approved outputs are left alone. A
// never-generated style's ready outputs are all "missing", so running it
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
  // Scoped rerun for this style: every not-approved ready output (new/missing +
  // rejected + changed + pending). Empty ⇒ nothing to regenerate (all approved,
  // or no ready outputs at all). The per-row Run button posts exactly these keys.
  variantKeys: string[];
  missing: number;
  rejected: number;
  changed: number;
  // Awaiting review, config unchanged (a plain pending re-run).
  pending: number;
  // A QUEUED/RUNNING job is already in flight — the row can't be re-run yet and
  // it's excluded from "Run all".
  inFlight: boolean;
  // Newest job for this style, or null if it never ran.
  lastRun: StyleLastRun | null;
};

// Per-output aggregate across every runnable (non-in-flight) style on the spec
// — powers the "Run all (N)" button on each output row. Keyed by base
// variantKey. toRun = missing + rejected + changed + pending (everything not
// approved).
export type OutputRunSummary = {
  toRun: number;
  missing: number;
  rejected: number;
  changed: number;
  pending: number;
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
  withChanged: number;
  withPending: number;
  // base variantKey → per-output run counts (for the per-output "Run all").
  byOutput: Record<string, OutputRunSummary>;
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
  withPending: 0,
  byOutput: {},
  rows: [],
});

export async function listProdSpecStyleRuns(prodSpecId: string): Promise<ProdSpecStyleRunList> {
  const spec = await db.prodSpec.findUnique({
    where: { id: prodSpecId },
    select: { active: true, outputs: true },
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
  const specOutputs = safeOutputs(spec.outputs);
  const currentKeys = currentKeyByBase(specOutputs);
  const currentVersions = currentContentVersionByBase(specOutputs);
  const stateByStyle = await loadLatestBaseStateByStyle(styleIds);

  // Styles with a QUEUED/RUNNING job — shown as "running", not runnable.
  const inflight = await db.job.findMany({
    where: { styleId: { in: styleIds }, status: { in: ["QUEUED", "RUNNING"] } },
    select: { styleId: true },
    distinct: ["styleId"],
  });
  const inflightSet = new Set(inflight.map((j) => j.styleId));

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
  const byOutput = new Map<string, OutputRunSummary>();
  const bumpOutput = (b: string, bucket: Exclude<OutputBucket, "ok">) => {
    let s = byOutput.get(b);
    if (!s) {
      s = { toRun: 0, missing: 0, rejected: 0, changed: 0, pending: 0 };
      byOutput.set(b, s);
    }
    s.toRun++;
    s[bucket]++;
  };
  let generatedStyles = 0;
  let toRerun = 0;
  let withMissing = 0;
  let withRejected = 0;
  let withChanged = 0;
  let withPending = 0;

  for (const c of candidates) {
    const state = stateByStyle.get(c.id);
    if (state && state.size > 0) generatedStyles++;
    const isInflight = inflightSet.has(c.id);

    const variantKeys: string[] = [];
    let missingN = 0;
    let rejectedN = 0;
    let changedN = 0;
    let pendingN = 0;
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
      const bucket = classifyOutput(state?.get(b), currentKeys.get(b) ?? null, currentVersions.get(b) ?? null);
      if (bucket === "ok") continue;
      variantKeys.push(o.variantKey);
      if (bucket === "missing") missingN++;
      else if (bucket === "rejected") rejectedN++;
      else if (bucket === "changed") changedN++;
      else pendingN++;
      // Per-output tallies mirror what "Run all" for that output would enqueue:
      // only styles that aren't already in flight.
      if (!isInflight) bumpOutput(b, bucket);
    }

    // "Run all" mirrors what the button will actually enqueue: runnable outputs
    // and not already in flight.
    if (variantKeys.length > 0 && !isInflight) {
      toRerun++;
      if (missingN > 0) withMissing++;
      if (rejectedN > 0) withRejected++;
      if (changedN > 0) withChanged++;
      if (pendingN > 0) withPending++;
    }

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
      pending: pendingN,
      inFlight: isInflight,
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
    withPending,
    byOutput: Object.fromEntries(byOutput),
    rows,
  };
}

// Defensive parse of the spec's outputs JSON — a malformed blob yields no
// current keys (so nothing reads as "changed") rather than throwing the list.
function safeOutputs(raw: unknown): ProdSpecOutput[] {
  try {
    return parseProdSpecOutputs(raw);
  } catch {
    return [];
  }
}
