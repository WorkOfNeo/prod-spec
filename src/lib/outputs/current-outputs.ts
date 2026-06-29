import type { MissingDetailField } from "@/lib/styles/detail-fields";
import type { ReadinessStyle } from "@/lib/styles/output-readiness";
import { GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";

// =====================================================
// Current outputs — the single source of truth for "what outputs does this
// style have, and what state is each in", read as the LATEST JobAsset per
// (style × variantKey) across all non-FAILED jobs, lined up against the
// ProdSpec's declared output set. This replaces "the newest AWAITING_REVIEW
// job" as the basis for review/status, so outputs generated in different runs
// (a Carton sticker today, a Care label next week) roll up under one Prod Spec.
//
// The supplier portal (app/s/[token]) already dedupes assets this way; this
// lib centralises it. The pure helpers (deriveOutputState, rollupOutputs) are
// DB-free so they can be unit-tested; getCurrentOutputsForStyle lazy-imports
// the DB + readiness chain.
// =====================================================

export type OutputState =
  | "AWAITING_DATA" // declared, fields not all resolved, not generated
  | "READY_TO_GENERATE" // fields resolved, not generated yet
  | "GENERATING" // an in-flight job covers this output
  | "TO_REVIEW" // generated, pending a decision
  | "BLOCKED" // generated but a placeholder blocks approval
  | "APPROVED"
  | "REJECTED";

export type CurrentOutput = {
  variantKey: string;
  name: string;
  state: OutputState;
  ready: boolean;
  missing: MissingDetailField[];
  // Identity / display for the review surfaces.
  docType: string;
  // The latest asset for this output, if any has been generated.
  jobId: string | null;
  fileName: string | null;
  jobAssetId: string | null;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED" | null;
  reviewedAt: Date | null;
  reviewedById: string | null;
  rejectReason: string | null;
  placeholderCount: number;
  generatedAt: Date | null; // asset.createdAt — when the output became available
  // true ⇒ this output's latest asset was produced by the style's NEWEST
  // generation job (the current run). false for outputs whose latest asset
  // comes from an earlier run, and for still-coming outputs (no asset yet).
  // Lets the review page tuck decided outputs from prior runs into a history
  // accordion without ever burying something still pending.
  fromLatestGeneration: boolean;
};

export type StyleOutputRollup = {
  total: number; // declared enabled outputs
  generated: number; // outputs with a latest asset
  awaitingData: number;
  readyToGenerate: number;
  generating: number;
  toReview: number;
  blocked: number;
  approved: number;
  rejected: number;
  // Your definition: a Prod Spec is "complete" only when EVERY declared
  // output has been generated; "fully approved" when all are approved.
  complete: boolean;
  fullyApproved: boolean;
};

type LatestAsset = {
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  placeholderCount: number;
};

// Pure: the state of one output from its readiness, whether a run is in flight,
// and its latest asset. A live regen takes precedence — re-running an approved
// output shows GENERATING, then TO_REVIEW once the new asset lands.
export function deriveOutputState(input: {
  ready: boolean;
  generating: boolean;
  latest: LatestAsset | null;
}): OutputState {
  if (input.generating) return "GENERATING";
  if (input.latest) {
    if (input.latest.reviewStatus === "APPROVED") return "APPROVED";
    if (input.latest.reviewStatus === "REJECTED") return "REJECTED";
    return input.latest.placeholderCount > 0 ? "BLOCKED" : "TO_REVIEW";
  }
  return input.ready ? "READY_TO_GENERATE" : "AWAITING_DATA";
}

// Pure: aggregate a style's outputs into the Prod Spec rollup.
export function rollupOutputs(outputs: CurrentOutput[]): StyleOutputRollup {
  const count = (s: OutputState) => outputs.filter((o) => o.state === s).length;
  return {
    total: outputs.length,
    generated: outputs.filter((o) => o.jobAssetId != null).length,
    awaitingData: count("AWAITING_DATA"),
    readyToGenerate: count("READY_TO_GENERATE"),
    generating: count("GENERATING"),
    toReview: count("TO_REVIEW"),
    blocked: count("BLOCKED"),
    approved: count("APPROVED"),
    rejected: count("REJECTED"),
    // "Complete" = every declared output has been generated (has an asset).
    complete: outputs.length > 0 && outputs.every((o) => o.jobAssetId != null),
    fullyApproved: outputs.length > 0 && outputs.every((o) => o.state === "APPROVED"),
  };
}

// Stable, URL/DOM-safe anchor for an output (variantKeys contain ":" and "#").
export function outputAnchor(variantKey: string): string {
  return `output-${variantKey.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

const base = (variantKey: string) => variantKey.split("#")[0];

// Most-actionable state first — used to summarise a multi-document slot by the
// single state that best describes it (a rejection or an in-flight regen matters
// more than a sibling that's already approved).
const SLOT_STATE_PRIORITY: OutputState[] = [
  "GENERATING",
  "REJECTED",
  "BLOCKED",
  "TO_REVIEW",
  "APPROVED",
  "READY_TO_GENERATE",
  "AWAITING_DATA",
];

// Pure: aggregate by OUTPUT SLOT (base variantKey) instead of per document. A
// multi-document output ("<base>#<suffix>", e.g. a carton X-of-Y per size/colour)
// collapses to ONE slot, so coverage reads "max outputs that will be generated"
// — stable before and after generation — rather than ballooning as documents
// land. A slot counts as generated when ANY of its documents has an asset; its
// review bucket is the most-actionable state among its documents. For
// single-document outputs this is identical to rollupOutputs.
export function rollupOutputSlots(outputs: CurrentOutput[]): StyleOutputRollup {
  const byBase = new Map<string, CurrentOutput[]>();
  for (const o of outputs) {
    const b = base(o.variantKey);
    const arr = byBase.get(b);
    if (arr) arr.push(o);
    else byBase.set(b, [o]);
  }

  const bucket: Record<OutputState, number> = {
    AWAITING_DATA: 0,
    READY_TO_GENERATE: 0,
    GENERATING: 0,
    TO_REVIEW: 0,
    BLOCKED: 0,
    APPROVED: 0,
    REJECTED: 0,
  };
  let generated = 0;
  for (const docs of byBase.values()) {
    if (docs.some((d) => d.jobAssetId != null)) generated += 1;
    const slotState =
      SLOT_STATE_PRIORITY.find((s) => docs.some((d) => d.state === s)) ?? "AWAITING_DATA";
    bucket[slotState] += 1;
  }

  const total = byBase.size;
  return {
    total,
    generated,
    awaitingData: bucket.AWAITING_DATA,
    readyToGenerate: bucket.READY_TO_GENERATE,
    generating: bucket.GENERATING,
    toReview: bucket.TO_REVIEW,
    blocked: bucket.BLOCKED,
    approved: bucket.APPROVED,
    rejected: bucket.REJECTED,
    complete: total > 0 && generated === total,
    fullyApproved: total > 0 && bucket.APPROVED === total,
  };
}

// DB read. Resolves the style's declared outputs + readiness, the newest asset
// per output across all non-FAILED jobs, and any in-flight generation, then
// derives each output's current state.
export async function getCurrentOutputsForStyle(styleId: string): Promise<CurrentOutput[]> {
  const { db } = await import("@/lib/db");
  const { ensureLayoutVariantsLoaded } = await import("@/lib/output-layouts/variants");
  const { outputReadinessForStyle } = await import("@/lib/styles/output-readiness");
  const { getVariant } = await import("@/lib/pdf/template-registry");

  // ProdSpec.outputs may reference Output Builder layouts (`layout:<id>`) —
  // load them before the readiness walk resolves variants.
  await ensureLayoutVariantsLoaded();

  const style = await db.style.findUnique({
    where: { id: styleId },
    select: {
      rawData: true,
      poNumber: true,
      cartonEan: true,
      supplier: { select: { country: true } },
      eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true } },
      customer: { select: { config: true } },
      prodSpec: { select: { outputs: true, columnMapping: true } },
    },
  });
  if (!style) return [];

  const readiness = outputReadinessForStyle(style as ReadinessStyle);

  // Every non-FAILED asset, newest job first.
  const assets = await db.jobAsset.findMany({
    where: { job: { styleId, status: { not: "FAILED" } } },
    orderBy: { job: { createdAt: "desc" } },
    select: {
      id: true,
      jobId: true,
      variantKey: true,
      docType: true,
      fileName: true,
      displayName: true,
      reviewStatus: true,
      reviewedAt: true,
      reviewedById: true,
      rejectReason: true,
      placeholderCount: true,
      createdAt: true,
    },
  });
  // The newest generation job = the job behind the most recent asset (assets
  // are ordered job-createdAt desc, so the first one wins). Used to flag each
  // output as belonging to the current run vs. an earlier one.
  const latestJobId = assets[0]?.jobId ?? null;

  // Newest asset per FULL variantKey — one entry per actual document, so a
  // multi-document output (carton X-of-Y, per size/colour: "<base>#<suffix>")
  // stays individually reviewable. Assets are ordered newest job first.
  const latestByVariant = new Map<string, (typeof assets)[number]>();
  for (const a of assets) {
    // The standalone "General information" framing PDF is retired — its pages
    // now ride inside the cover. Old jobs still carry __general_info__ assets;
    // skip them so they never surface as a current output anywhere.
    if (a.variantKey === GENERAL_INFO_VARIANT_KEY) continue;
    const key = a.variantKey ?? `doc:${a.docType}`;
    if (!latestByVariant.has(key)) latestByVariant.set(key, a);
  }

  // Bases with an in-flight (QUEUED/RUNNING) job. Empty variantKeys = full run.
  const inflight = await db.job.findMany({
    where: { styleId, status: { in: ["QUEUED", "RUNNING"] } },
    select: { variantKeys: true },
  });
  let generatingAll = false;
  const generatingSet = new Set<string>();
  for (const j of inflight) {
    const vks = Array.isArray(j.variantKeys) ? (j.variantKeys as unknown[]) : [];
    if (vks.length === 0) generatingAll = true;
    for (const k of vks) generatingSet.add(base(String(k)));
  }

  const declaredNameByBase = new Map<string, string>();
  for (const o of readiness) declaredNameByBase.set(base(o.variantKey), o.name);

  const outputs: CurrentOutput[] = [];
  const generatedBases = new Set<string>();

  // 1. One current output per generated document (latest per full variantKey).
  //    Includes bundle framing (cover, general info) and outputs since removed
  //    from the spec — they still belong to the review.
  for (const [key, a] of latestByVariant) {
    const b = base(key);
    generatedBases.add(b);
    const generating = generatingAll || generatingSet.has(b);
    outputs.push({
      variantKey: key,
      name: a.displayName ?? declaredNameByBase.get(b) ?? getVariant(b)?.name ?? a.docType,
      state: deriveOutputState({
        ready: true,
        generating,
        latest: { reviewStatus: a.reviewStatus, placeholderCount: a.placeholderCount },
      }),
      ready: true,
      missing: [],
      docType: a.docType,
      jobId: a.jobId,
      fileName: a.fileName,
      jobAssetId: a.id,
      reviewStatus: a.reviewStatus,
      reviewedAt: a.reviewedAt,
      reviewedById: a.reviewedById,
      rejectReason: a.rejectReason,
      placeholderCount: a.placeholderCount,
      generatedAt: a.createdAt,
      fromLatestGeneration: latestJobId != null && a.jobId === latestJobId,
    });
  }

  // 2. Declared outputs with nothing generated yet → one row each.
  for (const o of readiness) {
    const b = base(o.variantKey);
    if (generatedBases.has(b)) continue;
    const generating = generatingAll || generatingSet.has(b);
    outputs.push({
      variantKey: o.variantKey,
      name: o.name,
      state: deriveOutputState({ ready: o.ready, generating, latest: null }),
      ready: o.ready,
      missing: o.missing,
      docType: getVariant(b)?.docType ?? "OTHER",
      jobId: null,
      fileName: null,
      jobAssetId: null,
      reviewStatus: null,
      reviewedAt: null,
      reviewedById: null,
      rejectReason: null,
      placeholderCount: 0,
      generatedAt: null,
      fromLatestGeneration: false,
    });
  }

  return outputs;
}
