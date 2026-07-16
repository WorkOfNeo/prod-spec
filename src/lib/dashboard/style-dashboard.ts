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
// The summary (getStyleDashboardRows) deliberately does NOT run the heavy
// per-style readiness walk (outputReadinessForStyle) for every style — it reuses
// the PURE selectCurrentAssets/deriveOutputState helpers over a few batch
// queries. The declared-but-not-generated ("future") outputs and per-field
// detail surface on expand via getStyleOutputDetail → getCurrentOutputsForStyle.
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
};

export type UploadState = "uploaded" | "not-uploaded";
export type EmailState = "sent" | "not-sent";

export type StyleDashboardRow = {
  styleId: string;
  name: string;
  poNumber: string | null;
  customer: string | null;
  businessArea: string | null;
  supplier: string | null;
  hasInflight: boolean;
  rollup: StyleRollup;
  states: OutputState[]; // distinct output states present (drives the state facet)
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
export function rollupStyleSlots(docs: SlotDoc[]): {
  rollup: StyleRollup;
  states: OutputState[];
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

  const states = (Object.keys(bucket) as OutputState[]).filter((s) => bucket[s] > 0);

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
    },
    states,
    uploadStates,
    emailStates,
  };
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
      prodSpec: { select: { outputs: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (styles.length === 0) return [];

  const ids = styles.map((s) => s.id);

  // All non-FAILED assets (light — no pdf bytes), newest job first so
  // selectCurrentAssets can supersede per base. Grouped by style in memory.
  const [assets, inflight, queueRows] = await Promise.all([
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

  const rows: StyleDashboardRow[] = [];
  for (const style of styles) {
    const styleAssets = assetsByStyle.get(style.id) ?? [];
    const inf = inflightByStyle.get(style.id) ?? { all: false, bases: new Set<string>() };
    const delivery = deliveryByStyle.get(style.id) ?? new Map();

    // Declared base keys from the ProdSpec drive orphan-dropping in
    // selectCurrentAssets. When a style has no active spec, fall back to its own
    // asset bases so nothing is falsely dropped (the dashboard still shows what
    // was generated).
    let declared = currentOutputBaseKeys(parseProdSpecOutputs(style.prodSpec?.outputs ?? []));
    if (declared.size === 0) {
      declared = new Set(styleAssets.map((a) => baseKey(a.variantKey, a.docType)));
    }
    const current = selectCurrentAssets(styleAssets, declared);

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

    const { rollup, states, uploadStates, emailStates } = rollupStyleSlots(docs);

    const searchBlob = [
      style.name,
      style.poNumber,
      style.customer?.name,
      style.businessAreaRef?.name,
      style.supplier?.name,
      ...outputNames,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    rows.push({
      styleId: style.id,
      name: style.name,
      poNumber: style.poNumber,
      customer: style.customer?.name ?? null,
      businessArea: style.businessAreaRef?.name ?? null,
      supplier: style.supplier?.name ?? null,
      hasInflight: inf.all || inf.bases.size > 0,
      rollup,
      states,
      uploadStates,
      emailStates,
      latestGeneratedAt: latestGeneratedAt ? (latestGeneratedAt as Date).toISOString() : null,
      searchBlob,
    });
  }

  // In-flight styles first (that's the unclog view), then most-recent activity.
  rows.sort((a, b) => {
    if (a.hasInflight !== b.hasInflight) return a.hasInflight ? -1 : 1;
    return (b.latestGeneratedAt ?? "").localeCompare(a.latestGeneratedAt ?? "");
  });

  return rows;
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
