// =====================================================
// Style Dashboard — the data behind /settings/style-dashboard.
//
// One admin surface for the generation → SharePoint upload → supplier email
// pipeline, style-centric:
//   • getGenerationQueue()      — live in-flight jobs + how long each has waited
//   • getGenerationThroughput() — outputs GENERATED and SENT in the last 1h/24h/7d
//   • getStyleDashboardRows()   — every style that has generated outputs, with a
//                                 per-style rollup + the facets/search blob the
//                                 client filters on (summary only — cheap)
//   • getStyleOutputDetail()    — the full per-output rows for one style, on
//                                 expand: name, SharePoint link, uploaded?, emailed?
//
// The four per-output truths all already exist on origin/main — no new columns:
//   name     = CurrentOutput.name (displayName ?? declared ?? docType)
//   uploaded = SupplierSendQueueItem.sharePointStatus === "UPLOADED" (+ sharePointUrl)
//   emailed  = SupplierSendQueueItem.sentAt != null
// The delivery row is keyed (styleId, BASE variantKey) — the "#suffix" of a
// multi-document slot is stripped (see baseKey below), so delivery state is
// per output SLOT. Outputs with no queue row aren't approved yet ⇒ not uploaded,
// not emailed.
//
// The summary (getStyleDashboardRows) avoids the heavy per-style readiness walk
// across the whole book — it reuses the PURE selectCurrentAssets /
// deriveOutputState helpers over a few batch queries. It runs
// outputReadinessForStyle only for the narrow subset whose gap could be a
// doc-type keyword exclusion (phase 2), since that's the one thing the batch
// data can't decide: it needs each style's rawData. Per-field detail still
// surfaces on expand via getStyleOutputDetail → getCurrentOutputsForStyle.
// =====================================================

// db is lazy-imported inside each async fn (db.ts instantiates the Prisma
// client on import) so the pure helpers below stay unit-testable — same pattern
// as current-outputs.ts.
import {
  selectCurrentAssets,
  deriveOutputState,
  SLOT_STATE_PRIORITY,
  getCurrentOutputsForStyle,
  type OutputState,
} from "@/lib/outputs/current-outputs";
import { currentOutputBaseKeys } from "@/lib/tickets/orphan";
import { COVER_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import { decideCoverRun, type CoverRunSkip } from "@/lib/queue/cover-run-gate";
// Type-only — output-readiness itself is import-safe, but the fn is lazy-loaded
// below since it's only needed for the narrow exclusion pass.
import type { ReadinessStyle } from "@/lib/styles/output-readiness";
// parseProdSpecOutputs is lazy-imported in getStyleDashboardRows — its module
// (prod-spec/config) transitively pulls in the DB client, which would break the
// pure-helper unit tests if imported at the top level.

// ---- Windows -----------------------------------------------------------------

export type DashboardWindow = "1h" | "24h" | "7d";

const WINDOW_MS: Record<DashboardWindow, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
};

export const DASHBOARD_WINDOWS: DashboardWindow[] = ["1h", "24h", "7d"];

// ---- Types -------------------------------------------------------------------

export type ThroughputStat = { generated: number; sent: number };
export type GenerationThroughput = Record<DashboardWindow, ThroughputStat>;

export type QueueItem = {
  jobId: string;
  styleId: string;
  styleName: string;
  poNumber: string | null;
  status: "QUEUED" | "RUNNING";
  // number of outputs this job renders; null = whole style ("all enabled outputs")
  outputCount: number | null;
  waitingSince: string; // ISO createdAt (enqueue time)
  startedAt: string | null; // ISO — set when the runner claimed it (RUNNING)
  ageSeconds: number; // server snapshot of now − (startedAt ?? createdAt)
};

export type GenerationQueue = {
  queued: number;
  running: number;
  oldestWaitSeconds: number | null;
  items: QueueItem[];
};

export type StyleRollup = {
  generatedSlots: number;
  generating: number;
  toReview: number;
  blocked: number;
  approved: number;
  rejected: number;
  uploadedSlots: number;
  sentSlots: number;
  // Enabled declared outputs with no asset that SHOULD have one — a real gap.
  // Deliberately excludes the intentional cases (output disabled on the spec,
  // operator-ignored, or skipped by a doc-type keyword rule), so this only
  // counts outputs genuinely waiting to be generated — what "Run all" sweeps in.
  // Expanding the style shows whether each is ready or missing fields.
  notGenerated: number;
};

export type UploadState = "uploaded" | "not-uploaded";
export type EmailState = "sent" | "not-sent";

// The Output-state facet value set. A never-generated output has no document and
// therefore no OutputState of its own in the rollup, so it gets a synthetic
// value — otherwise the one case you most want to filter for ("this style has an
// output that never generated") would be unfilterable.
export type StyleFacetState = OutputState | "NOT_GENERATED";

// Where the style's cover page is, end to end — the one document every style
// with a PO number gets, so it's the first thing to look at when asking "did
// anything happen for this style?".
export type CoverStatus = "none" | "generating" | "to-review" | "approved" | "uploaded" | "sent";

// The coarse lifecycle the Progress facet filters on.
export type ProgressState = "not-started" | "in-progress" | "delivered";

export type StyleDashboardRow = {
  styleId: string;
  name: string;
  poNumber: string | null;
  customer: string | null;
  businessArea: string | null;
  supplier: string | null;
  // The spec is "Cover page only" — every other document is supplied by hand.
  coverOnly: boolean;
  hasInflight: boolean;
  cover: CoverStatus;
  progress: ProgressState;
  // Set when nothing has been generated for this style yet: why not, in the
  // operator's words, and whether that needs a person (attention) or just the
  // next sweep.
  waiting: { reason: string; attention: boolean } | null;
  rollup: StyleRollup;
  // Everything this style declares is generated, approved, uploaded to SharePoint
  // AND emailed to the supplier — nothing left to do. Drives the green row.
  fullyDelivered: boolean;
  states: StyleFacetState[]; // distinct output states present (drives the state facet)
  uploadStates: UploadState[]; // among generated slots
  emailStates: EmailState[]; // among generated slots
  latestGeneratedAt: string | null; // ISO — most recent asset, for sort/display
  searchBlob: string; // lowercased: name + PO + customer + BA + supplier + output names
};

export type StyleOutputDetailRow = {
  variantKey: string;
  name: string;
  state: OutputState;
  fileName: string | null;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED" | null;
  generatedAt: string | null; // ISO
  sharePointStatus: string | null;
  sharePointUrl: string | null;
  sharePointFolderUrl: string | null;
  uploaded: boolean;
  emailed: boolean;
};

// ---- Pure helpers (unit-tested in style-dashboard.test.ts) --------------------

// Base variantKey of a document — the "#suffix" of a multi-document slot is
// stripped, matching how supplier-send-queue keys its rows. A null variantKey
// (legacy asset) collapses to `doc:<docType>`, same as the queue side.
export function baseKey(variantKey: string | null, docType: string): string {
  return (variantKey ?? `doc:${docType}`).split("#")[0];
}

type SlotDoc = {
  base: string;
  state: OutputState;
  generated: boolean; // has an asset
  uploaded: boolean;
  emailed: boolean;
};

// Pure: collapse a style's current documents to output SLOTS (by base), then
// roll up counts + the distinct facet value sets. A multi-document slot (carton
// X-of-Y per size) counts once; its slot state is the most-actionable among its
// documents (SLOT_STATE_PRIORITY), and it's "uploaded"/"emailed" when its
// delivery row is. upload/email facet values are scoped to GENERATED slots (a
// not-yet-approved output legitimately reads "not uploaded / not sent").
export function rollupStyleSlots(
  docs: SlotDoc[],
  // Declared slots with no asset — counted by the caller (declared bases minus
  // generated bases); they have no document to bucket, so they're passed in.
  notGenerated = 0,
): {
  rollup: StyleRollup;
  states: StyleFacetState[];
  uploadStates: UploadState[];
  emailStates: EmailState[];
} {
  const byBase = new Map<string, SlotDoc[]>();
  for (const d of docs) {
    const arr = byBase.get(d.base);
    if (arr) arr.push(d);
    else byBase.set(d.base, [d]);
  }

  const bucket: Record<OutputState, number> = {
    AWAITING_DATA: 0,
    READY_TO_GENERATE: 0,
    GENERATING: 0,
    TO_REVIEW: 0,
    BLOCKED: 0,
    APPROVED: 0,
    REJECTED: 0,
    EXCLUDED: 0,
  };
  let generatedSlots = 0;
  let uploadedSlots = 0;
  let sentSlots = 0;
  let anyNotUploaded = false;
  let anyNotSent = false;

  for (const slot of byBase.values()) {
    const generated = slot.some((d) => d.generated);
    const uploaded = slot.some((d) => d.uploaded);
    const emailed = slot.some((d) => d.emailed);
    const slotState = SLOT_STATE_PRIORITY.find((s) => slot.some((d) => d.state === s)) ?? "AWAITING_DATA";
    bucket[slotState] += 1;
    if (generated) {
      generatedSlots += 1;
      if (uploaded) uploadedSlots += 1;
      else anyNotUploaded = true;
      if (emailed) sentSlots += 1;
      else anyNotSent = true;
    }
  }

  const uploadStates: UploadState[] = [];
  if (uploadedSlots > 0) uploadStates.push("uploaded");
  if (anyNotUploaded) uploadStates.push("not-uploaded");
  const emailStates: EmailState[] = [];
  if (sentSlots > 0) emailStates.push("sent");
  if (anyNotSent) emailStates.push("not-sent");

  const states: StyleFacetState[] = (Object.keys(bucket) as OutputState[]).filter((s) => bucket[s] > 0);
  if (notGenerated > 0) states.push("NOT_GENERATED");

  return {
    rollup: {
      generatedSlots,
      generating: bucket.GENERATING,
      toReview: bucket.TO_REVIEW,
      blocked: bucket.BLOCKED,
      approved: bucket.APPROVED,
      rejected: bucket.REJECTED,
      uploadedSlots,
      sentSlots,
      notGenerated,
    },
    states,
    uploadStates,
    emailStates,
  };
}

// Pure: "nothing left to do" — every declared output is generated, every
// generated slot is approved (nothing generating / to review / blocked /
// rejected), and every one of them is BOTH uploaded to SharePoint and emailed
// to the supplier. Deliberately conservative: it never reports done while
// something is unfinished, so a style with a never-generated output (whatever
// the reason) stays un-green.
export function isFullyDelivered(rollup: StyleRollup): boolean {
  return (
    rollup.generatedSlots > 0 &&
    rollup.notGenerated === 0 &&
    rollup.generating === 0 &&
    rollup.toReview === 0 &&
    rollup.blocked === 0 &&
    rollup.rejected === 0 &&
    rollup.uploadedSlots === rollup.generatedSlots &&
    rollup.sentSlots === rollup.generatedSlots
  );
}

// Pure: where the cover is. Delivery wins over review state — once the file
// is in the supplier's folder (the cover ships regardless of approval), that's
// the fact that matters.
export function coverStatusOf(input: {
  hasCover: boolean;
  reviewStatus: string | null;
  uploaded: boolean;
  emailed: boolean;
  inflight: boolean;
}): CoverStatus {
  if (!input.hasCover) return input.inflight ? "generating" : "none";
  if (input.emailed) return "sent";
  if (input.uploaded) return "uploaded";
  if (input.inflight) return "generating";
  return input.reviewStatus === "APPROVED" ? "approved" : "to-review";
}

// Pure: why a style with a PO number and an active spec hasn't started, read
// off the SAME gate the generator uses (decideCoverRun) so the dashboard can't
// claim a run is coming that the sweep would refuse.
export function explainNotStarted(
  skip: CoverRunSkip | null,
  failures: { count: number; lastError: string | null },
): { reason: string; attention: boolean } {
  const lastError = failures.lastError ? ` Last error: ${failures.lastError.slice(0, 200)}` : "";
  switch (skip) {
    case null:
      return failures.count > 0
        ? {
            reason: `The last run failed — the next sweep retries it (or press Run all).${lastError}`,
            attention: true,
          }
        : {
            reason: "Not started yet — the next sweep queues it, cover page first (or press Run all).",
            attention: false,
          };
    case "auto_off":
      return {
        reason:
          "Auto-generate is switched off, so nothing starts on its own. Re-run the style, or switch auto-generate on.",
        attention: true,
      };
    case "no_outputs":
      return {
        reason: "Its prod spec has no outputs. Add outputs, or tick “Cover page only” on the spec.",
        attention: true,
      };
    case "floated":
      return {
        reason: `Failed ${failures.count}× since the spec last changed — left for a person to look at.${lastError}`,
        attention: true,
      };
    case "in_flight":
      return { reason: "Queued — generating now.", attention: false };
    default:
      return { reason: "Not started.", attention: false };
  }
}

// ---- Live queue --------------------------------------------------------------

// In-flight generation jobs (QUEUED = waiting, RUNNING = rendering), oldest
// first — the head of the line is the worst wait. The runner drains oldest
// createdAt first and auto-requeues any RUNNING job older than 15 min, so a
// persistent backlog here is what the "Run All" button clears.
export async function getGenerationQueue(): Promise<GenerationQueue> {
  const { db } = await import("@/lib/db");
  const jobs = await db.job.findMany({
    where: { status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      status: true,
      createdAt: true,
      startedAt: true,
      variantKeys: true,
      style: { select: { id: true, name: true, poNumber: true } },
    },
  });

  const now = Date.now();
  let queued = 0;
  let running = 0;
  let oldestWaitSeconds: number | null = null;

  const items: QueueItem[] = jobs.map((j) => {
    if (j.status === "RUNNING") running += 1;
    else queued += 1;
    const vks = Array.isArray(j.variantKeys) ? (j.variantKeys as unknown[]) : [];
    const since = j.status === "RUNNING" ? (j.startedAt ?? j.createdAt) : j.createdAt;
    const ageSeconds = Math.max(0, Math.floor((now - since.getTime()) / 1000));
    // Oldest wait tracks how long the front of the queue has been enqueued.
    const waitSeconds = Math.floor((now - j.createdAt.getTime()) / 1000);
    if (oldestWaitSeconds == null || waitSeconds > oldestWaitSeconds) oldestWaitSeconds = waitSeconds;
    return {
      jobId: j.id,
      styleId: j.style.id,
      styleName: j.style.name,
      poNumber: j.style.poNumber,
      status: j.status as "QUEUED" | "RUNNING",
      outputCount: vks.length === 0 ? null : vks.length,
      waitingSince: j.createdAt.toISOString(),
      startedAt: j.startedAt ? j.startedAt.toISOString() : null,
      ageSeconds,
    };
  });

  return { queued, running, oldestWaitSeconds, items };
}

// ---- Throughput --------------------------------------------------------------

// "Done" per window, both senses the user asked for:
//   generated = JobAsset rows created in the window (documents rendered; FAILED
//               jobs excluded, matching the review surfaces)
//   sent      = SupplierSendQueueItem rows whose sentAt fell in the window
//               (indexed) — outputs emailed to the supplier
export async function getGenerationThroughput(): Promise<GenerationThroughput> {
  const { db } = await import("@/lib/db");
  const now = Date.now();
  const entries = await Promise.all(
    DASHBOARD_WINDOWS.map(async (w) => {
      const since = new Date(now - WINDOW_MS[w]);
      const [generated, sent] = await Promise.all([
        db.jobAsset.count({ where: { createdAt: { gte: since }, job: { status: { not: "FAILED" } } } }),
        db.supplierSendQueueItem.count({ where: { sentAt: { gte: since } } }),
      ]);
      return [w, { generated, sent }] as const;
    }),
  );
  return Object.fromEntries(entries) as GenerationThroughput;
}

// ---- Style rows (summary) ----------------------------------------------------

// Every style that has entered generation (≥1 non-FAILED asset OR an in-flight
// job), with a per-style rollup + facet/search fields. Built from a handful of
// batch queries + the pure current-asset selection — no per-style DB fan-out.
export async function getStyleDashboardRows(): Promise<StyleDashboardRow[]> {
  const { db } = await import("@/lib/db");
  const { parseProdSpecOutputs } = await import("@/lib/prod-spec/config");
  const { ensureLayoutVariantsLoaded } = await import("@/lib/output-layouts/variants");
  const { getVariant } = await import("@/lib/pdf/template-registry");
  const { loadDocTypeExclusionRules } = await import("@/lib/pdf/doc-types-db");

  // ProdSpec outputs can reference Output Builder layouts (`layout:<id>`), so
  // the registry has to be loaded before any base key can be mapped to its
  // document type below.
  await ensureLayoutVariantsLoaded();

  const styles = await db.style.findMany({
    where: {
      jobs: {
        some: {
          OR: [
            { status: { in: ["QUEUED", "RUNNING"] } },
            { AND: [{ status: { not: "FAILED" } }, { assets: { some: {} } }] },
          ],
        },
      },
    },
    select: {
      id: true,
      name: true,
      poNumber: true,
      customer: { select: { name: true } },
      businessAreaRef: { select: { name: true } },
      supplier: { select: { name: true } },
      prodSpec: { select: { outputs: true, coverOnly: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  const ids = styles.map((s) => s.id);
  const notStarted = await getNotStartedRows();
  if (styles.length === 0) return notStarted;

  // All non-FAILED assets (light — no pdf bytes), newest job first so
  // selectCurrentAssets can supersede per base. Grouped by style in memory.
  const [assets, inflight, queueRows, ignoreRows, exclusionRules] = await Promise.all([
    db.jobAsset.findMany({
      where: { job: { styleId: { in: ids }, status: { not: "FAILED" } } },
      orderBy: { job: { createdAt: "desc" } },
      select: {
        jobId: true,
        docType: true,
        variantKey: true,
        displayName: true,
        reviewStatus: true,
        placeholderCount: true,
        createdAt: true,
        job: { select: { styleId: true } },
      },
    }),
    db.job.findMany({
      where: { styleId: { in: ids }, status: { in: ["QUEUED", "RUNNING"] } },
      select: { styleId: true, variantKeys: true },
    }),
    db.supplierSendQueueItem.findMany({
      where: { styleId: { in: ids } },
      select: { styleId: true, variantKey: true, sharePointStatus: true, sentAt: true },
    }),
    // Per-style operator ignores ("not wanted for THIS style"). An ignored
    // output is deliberately never generated, so it isn't a gap. Fail-soft like
    // output-ignores.ts — the table is additive and may predate a db:deploy.
    db.styleOutputIgnore
      .findMany({ where: { styleId: { in: ids } }, select: { styleId: true, variantKey: true } })
      .catch(() => [] as Array<{ styleId: string; variantKey: string }>),
    loadDocTypeExclusionRules(),
  ]);

  type AssetRow = (typeof assets)[number];
  const assetsByStyle = new Map<string, AssetRow[]>();
  for (const a of assets) {
    const arr = assetsByStyle.get(a.job.styleId);
    if (arr) arr.push(a);
    else assetsByStyle.set(a.job.styleId, [a]);
  }

  // In-flight generation per style: whole-style (empty variantKeys) or a set of
  // base keys.
  const inflightByStyle = new Map<string, { all: boolean; bases: Set<string> }>();
  for (const j of inflight) {
    const entry = inflightByStyle.get(j.styleId) ?? { all: false, bases: new Set<string>() };
    const vks = Array.isArray(j.variantKeys) ? (j.variantKeys as unknown[]) : [];
    if (vks.length === 0) entry.all = true;
    for (const k of vks) entry.bases.add(String(k).split("#")[0]);
    inflightByStyle.set(j.styleId, entry);
  }

  // Delivery per (styleId, base). variantKey on the queue is already the base.
  const deliveryByStyle = new Map<string, Map<string, { uploaded: boolean; emailed: boolean }>>();
  for (const q of queueRows) {
    const m = deliveryByStyle.get(q.styleId) ?? new Map();
    m.set(q.variantKey, { uploaded: q.sharePointStatus === "UPLOADED", emailed: q.sentAt != null });
    deliveryByStyle.set(q.styleId, m);
  }

  // Per-style operator ignores, keyed by base variantKey.
  const ignoresByStyle = new Map<string, Set<string>>();
  for (const r of ignoreRows) {
    const s = ignoresByStyle.get(r.styleId) ?? new Set<string>();
    s.add(r.variantKey);
    ignoresByStyle.set(r.styleId, s);
  }
  // Document types that carry a keyword rule at all (e.g. WASHCARE /
  // CARE_LABEL for socks + shoes). Only a gap in one of these — or in an
  // output with rules of its own, checked alongside below — could be an
  // exclusion rather than a miss, so only styles with such a gap pay for the
  // rawData load in phase 2.
  const ruleDocTypes = new Set(
    Object.entries(exclusionRules)
      .filter(([, r]) => Array.isArray(r) && r.length > 0)
      .map(([docType]) => docType),
  );

  // ---- Phase 1: current documents + the cheap part of the gap ----
  type Pending = {
    style: (typeof styles)[number];
    docs: SlotDoc[];
    outputNames: string[];
    latestGeneratedAt: Date | null;
    hasInflight: boolean;
    ungenerated: Set<string>;
    cover: CoverStatus;
  };
  const pending: Pending[] = [];
  const needsExclusionCheck: string[] = [];

  for (const style of styles) {
    const styleAssets = assetsByStyle.get(style.id) ?? [];
    const inf = inflightByStyle.get(style.id) ?? { all: false, bases: new Set<string>() };
    const delivery = deliveryByStyle.get(style.id) ?? new Map();
    const parsed = parseProdSpecOutputs(style.prodSpec?.outputs ?? []);

    // Orphan-dropping in selectCurrentAssets keys off ALL declared bases
    // (enabled or not), matching current-outputs. When a style has no active
    // spec, fall back to its own asset bases so nothing is falsely dropped.
    let declared = currentOutputBaseKeys(parsed);
    if (declared.size === 0) {
      declared = new Set(styleAssets.map((a) => baseKey(a.variantKey, a.docType)));
    }
    const current = selectCurrentAssets(styleAssets, declared);
    const generatedBases = new Set(current.map((a) => baseKey(a.variantKey, a.docType)));

    // The gap: ENABLED declared outputs with no asset, minus the ones that are
    // deliberately never generated — a disabled output and an operator-ignored
    // output are both intentional, so neither is a gap. What survives is either
    // genuinely never-run (the runner readiness-gates outputs, so one whose
    // fields weren't resolved at run time was skipped and sits here until a
    // sweep re-runs it — what "Run all" picks up) or excluded by a doc-type
    // keyword rule, which phase 2 settles.
    const ignored = ignoresByStyle.get(style.id);
    const ungenerated = new Set(
      [...currentOutputBaseKeys(parsed.filter((o) => o.enabled !== false))].filter(
        (b) => !generatedBases.has(b) && !ignored?.has(b),
      ),
    );
    if (
      [...ungenerated].some((b) => {
        const v = getVariant(b);
        // Either the OUTPUT carries its own rules (Output Builder Settings
        // tab) or its document type does — both can turn this gap into an
        // intentional exclusion, so both make phase 2 worth paying for.
        return (v?.generationRules?.length ?? 0) > 0 || ruleDocTypes.has(v?.docType ?? "");
      })
    ) {
      needsExclusionCheck.push(style.id);
    }

    const outputNames: string[] = [];
    let latestGeneratedAt: Date | null = null;
    const docs: SlotDoc[] = current.map((a) => {
      const base = baseKey(a.variantKey, a.docType);
      const generating = inf.all || inf.bases.has(base);
      const del = delivery.get(base) ?? { uploaded: false, emailed: false };
      if (a.displayName) outputNames.push(a.displayName);
      if (!latestGeneratedAt || a.createdAt > latestGeneratedAt) latestGeneratedAt = a.createdAt;
      return {
        base,
        state: deriveOutputState({
          ready: true,
          generating,
          latest: { reviewStatus: a.reviewStatus, placeholderCount: a.placeholderCount },
        }),
        generated: true,
        uploaded: del.uploaded,
        emailed: del.emailed,
      };
    });

    const coverAsset = current.find((a) => a.variantKey === COVER_VARIANT_KEY);
    const coverDelivery = delivery.get(COVER_VARIANT_KEY) ?? { uploaded: false, emailed: false };
    pending.push({
      style,
      docs,
      outputNames,
      latestGeneratedAt,
      hasInflight: inf.all || inf.bases.size > 0,
      ungenerated,
      cover: coverStatusOf({
        hasCover: !!coverAsset,
        reviewStatus: coverAsset?.reviewStatus ?? null,
        uploaded: coverDelivery.uploaded,
        emailed: coverDelivery.emailed,
        inflight: inf.all,
      }),
    });
  }

  // ---- Phase 2: settle keyword exclusions, for that subset only ----
  // Runs the SAME readiness engine the runner uses, so "excluded" here can never
  // disagree with what the runner skips or what the expanded detail shows. Only
  // this subset loads rawData — doing it for every style is what made a correct
  // exclusion check too expensive for the list.
  if (needsExclusionCheck.length > 0) {
    const { outputReadinessForStyle } = await import("@/lib/styles/output-readiness");
    const checked = await db.style.findMany({
      where: { id: { in: needsExclusionCheck } },
      select: {
        id: true,
        rawData: true,
        poNumber: true,
        cartonEan: true,
        supplier: { select: { country: true } },
        eans: { orderBy: { position: "asc" }, select: { size: true, ean13: true, cartonEan: true } },
        customer: { select: { config: true } },
        prodSpec: { select: { outputs: true, columnMapping: true } },
      },
    });
    const excludedByStyle = new Map<string, Set<string>>();
    for (const s of checked) {
      const readiness = outputReadinessForStyle(
        s as ReadinessStyle,
        exclusionRules,
        undefined,
        ignoresByStyle.get(s.id),
      );
      excludedByStyle.set(
        s.id,
        new Set(readiness.filter((r) => r.excluded === true).map((r) => r.variantKey.split("#")[0])),
      );
    }
    for (const p of pending) {
      const excluded = excludedByStyle.get(p.style.id);
      if (!excluded) continue;
      for (const b of excluded) p.ungenerated.delete(b);
    }
  }

  // ---- Phase 3: roll up ----
  const rows: StyleDashboardRow[] = pending.map((p) => {
    const { style } = p;
    const { rollup, states, uploadStates, emailStates } = rollupStyleSlots(
      p.docs,
      p.ungenerated.size,
    );

    const searchBlob = [
      style.name,
      style.poNumber,
      style.customer?.name,
      style.businessAreaRef?.name,
      style.supplier?.name,
      ...p.outputNames,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const fullyDelivered = isFullyDelivered(rollup);
    return {
      styleId: style.id,
      name: style.name,
      poNumber: style.poNumber,
      customer: style.customer?.name ?? null,
      businessArea: style.businessAreaRef?.name ?? null,
      supplier: style.supplier?.name ?? null,
      coverOnly: style.prodSpec?.coverOnly === true,
      hasInflight: p.hasInflight,
      cover: p.cover,
      progress: fullyDelivered ? "delivered" : "in-progress",
      waiting: null,
      rollup,
      fullyDelivered,
      states,
      uploadStates,
      emailStates,
      latestGeneratedAt: p.latestGeneratedAt ? p.latestGeneratedAt.toISOString() : null,
      searchBlob,
    };
  });

  rows.push(...notStarted);

  // In-flight styles first (that's the unclog view), then most-recent activity;
  // not-started styles (no activity yet) settle at the end.
  rows.sort((a, b) => {
    if (a.hasInflight !== b.hasInflight) return a.hasInflight ? -1 : 1;
    return (b.latestGeneratedAt ?? "").localeCompare(a.latestGeneratedAt ?? "");
  });

  return rows;
}

// ---- Not-started styles -------------------------------------------------------

// The styles that SHOULD be in the pipeline but have nothing in it yet: a PO
// number ("Navision Task"), an active prod spec, inside the generation PO
// cutoff, and no generated document or in-flight job. Without these the list
// only ever showed styles that had already produced something, so "my cover
// pages aren't being made" looked identical to "there's nothing to make".
// Each carries the reason it hasn't started, from the generator's own gate.
// Capped: this is a "what's stuck" view, newest first, not an archive.
const NOT_STARTED_CAP = 500;

// The jobs filter is the exact complement of getStyleDashboardRows' "started"
// filter, so the two lists never overlap.
async function getNotStartedRows(): Promise<StyleDashboardRow[]> {
  const { db } = await import("@/lib/db");
  const { parseProdSpecOutputs } = await import("@/lib/prod-spec/config");
  const { HAS_PO_NUMBER_WHERE } = await import("@/lib/styles/active-filter");
  const { getAutoGenerateEnabled, getGenerationMinPo } = await import("@/lib/settings/app-settings");

  const [autoGenerateEnabled, minPo] = await Promise.all([getAutoGenerateEnabled(), getGenerationMinPo()]);
  const styles = await db.style.findMany({
    where: {
      ...HAS_PO_NUMBER_WHERE,
      prodSpec: { is: { active: true } },
      jobs: {
        none: {
          OR: [
            { status: { in: ["QUEUED", "RUNNING"] } },
            { AND: [{ status: { not: "FAILED" } }, { assets: { some: {} } }] },
          ],
        },
      },
      ...(minPo !== null ? { OR: [{ poSeq: { gte: minPo } }, { poSeq: null }] } : {}),
    },
    select: {
      id: true,
      name: true,
      poNumber: true,
      customer: { select: { name: true } },
      businessAreaRef: { select: { name: true } },
      supplier: { select: { name: true } },
      prodSpec: { select: { active: true, outputs: true, coverOnly: true, updatedAt: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: NOT_STARTED_CAP,
  });
  if (styles.length === 0) return [];

  const failed = await db.job.findMany({
    where: { styleId: { in: styles.map((s) => s.id) }, status: "FAILED" },
    orderBy: { createdAt: "desc" },
    select: { styleId: true, createdAt: true, error: true },
  });
  const failedByStyle = new Map<string, typeof failed>();
  for (const f of failed) {
    const arr = failedByStyle.get(f.styleId);
    if (arr) arr.push(f);
    else failedByStyle.set(f.styleId, [f]);
  }

  return styles.map((style) => {
    const spec = style.prodSpec;
    const enabled = parseProdSpecOutputs(spec?.outputs ?? []).filter((o) => o.enabled !== false);
    // Same window the generator counts: failures since the spec last changed.
    const recent = (failedByStyle.get(style.id) ?? []).filter(
      (f) => !spec || f.createdAt >= spec.updatedAt,
    );
    const gate = decideCoverRun({
      hasPo: true,
      belowCutoff: false,
      prodSpec: spec,
      specHasOutputs: enabled.length > 0,
      autoGenerateEnabled,
      inflight: 0,
      recentFailures: recent.length,
      hasCover: false,
    });
    // With auto-generate off the backlog sweep doesn't run at all, so even a
    // cover-only style (which the gate lets through) waits for a person.
    const skip = gate === null && !autoGenerateEnabled ? "auto_off" : gate;
    const { rollup, states, uploadStates, emailStates } = rollupStyleSlots(
      [],
      currentOutputBaseKeys(enabled).size,
    );
    return {
      styleId: style.id,
      name: style.name,
      poNumber: style.poNumber,
      customer: style.customer?.name ?? null,
      businessArea: style.businessAreaRef?.name ?? null,
      supplier: style.supplier?.name ?? null,
      coverOnly: spec?.coverOnly === true,
      hasInflight: false,
      cover: "none" as const,
      progress: "not-started" as const,
      waiting: explainNotStarted(skip, {
        count: recent.length,
        lastError: recent[0]?.error ?? null,
      }),
      rollup,
      fullyDelivered: false,
      states,
      uploadStates,
      emailStates,
      latestGeneratedAt: null,
      searchBlob: [
        style.name,
        style.poNumber,
        style.customer?.name,
        style.businessAreaRef?.name,
        style.supplier?.name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    };
  });
}

// ---- Per-style output detail (expand) ----------------------------------------

// The full current output set for one style (including declared-but-not-yet-
// generated "future" outputs), each attached to its SharePoint + supplier-email
// state. Reuses the canonical getCurrentOutputsForStyle so the detail matches
// exactly what the style/review pages consider "current".
export async function getStyleOutputDetail(styleId: string): Promise<StyleOutputDetailRow[]> {
  const { db } = await import("@/lib/db");
  const [outputs, queueRows] = await Promise.all([
    getCurrentOutputsForStyle(styleId),
    db.supplierSendQueueItem.findMany({
      where: { styleId },
      select: {
        variantKey: true,
        sharePointStatus: true,
        sharePointUrl: true,
        sharePointFolderUrl: true,
        sentAt: true,
      },
    }),
  ]);

  const delivery = new Map(queueRows.map((q) => [q.variantKey, q]));

  return outputs.map((o) => {
    const del = delivery.get(baseKey(o.variantKey, o.docType));
    return {
      variantKey: o.variantKey,
      name: o.name,
      state: o.state,
      fileName: o.fileName,
      reviewStatus: o.reviewStatus,
      generatedAt: o.generatedAt ? o.generatedAt.toISOString() : null,
      sharePointStatus: del?.sharePointStatus ?? null,
      sharePointUrl: del?.sharePointUrl ?? null,
      sharePointFolderUrl: del?.sharePointFolderUrl ?? null,
      uploaded: del?.sharePointStatus === "UPLOADED",
      emailed: del?.sentAt != null,
    };
  });
}
