import { db } from "@/lib/db";
import {
  getAutomationMinPo,
  getAutoGenerateEnabled,
  getGenerationMinPo,
  getPoEanAutoRunEnabled,
  getSupplierBatchSendEnabled,
  getSupplierSendMinPo,
} from "@/lib/settings/app-settings";
import { MAX_EAN_ATTEMPTS } from "@/lib/po/ean-status-meta";
import { MAX_GEN_ATTEMPTS } from "@/lib/queue/generation-sweep";
import { MAX_PUSH_ATTEMPTS } from "@/lib/sharepoint/push-queued-to-supplier";

// =====================================================
// Pipeline snapshot — the funnel /automation renders: one row per stage of
// the style → supplier journey, counted the way the automations themselves
// scope their work (cutoff-scoped; styles below the generation cutoff are
// parked and summarised separately). Every stage links to the surface where
// the rows can actually be acted on, and carries its "gave up" float count —
// the things that need a human.
//
// Counts derive from status columns only (eanStatus, Style.status, JobStatus,
// queue sharePointStatus/sentAt) — no per-output readiness walk, so the page
// stays a cheap read. "Ready to generate" therefore means complete styles in
// the sweep's scope (same query as the sweep's candidate prefilter), not the
// per-output trickle — that nuance lives on the style page.
// =====================================================

export type PipelineStage = {
  key: string;
  label: string;
  count: number;
  floated: number; // gave-up rows stuck at this stage (3-strike caps)
  hint: string;
  href: string;
};

export type PipelineSnapshot = {
  scrapeCutoff: number | null;
  genCutoff: number | null;
  supplierCutoff: number | null;
  parkedBelowGen: number;
  switches: { autoScrape: boolean; autoGen: boolean; supplierSend: boolean };
  stages: PipelineStage[];
};

export async function getPipelineSnapshot(): Promise<PipelineSnapshot> {
  const [autoScrape, autoGen, supplierSend, scrapeCutoff, genCutoff, supplierCutoff] =
    await Promise.all([
      getPoEanAutoRunEnabled(),
      getAutoGenerateEnabled(),
      getSupplierBatchSendEnabled(),
      getAutomationMinPo(),
      getGenerationMinPo(),
      getSupplierSendMinPo(),
    ]);

  // Generation-window scoping — the sweep's own rule: at/above the cutoff OR
  // no parseable PO (those can't be placed on the timeline and still run).
  const genWindow =
    genCutoff !== null ? { OR: [{ poSeq: { gte: genCutoff } }, { poSeq: null }] } : {};

  // Styles whose generation gave up (>= MAX_GEN_ATTEMPTS FAILED jobs). Two
  // steps because "count of failed jobs per style" isn't expressible in a
  // single count(): groupBy first, then scope the survivors to pre-generation
  // styles still waiting.
  const failedGroups = await db.job.groupBy({
    by: ["styleId"],
    where: { status: "FAILED" },
    _count: { _all: true },
    having: { styleId: { _count: { gte: MAX_GEN_ATTEMPTS } } },
  });
  const genFloatCandidates = failedGroups.map((g) => g.styleId);

  const [
    awaitingBarcodes,
    floatedEan,
    readyToGenerate,
    floatedGen,
    generating,
    awaitingReview,
    awaitingUpload,
    floatedUpload,
    uploadedAwaitingDigest,
    sentLast7,
    parkedBelowGen,
  ] = await Promise.all([
    // 1. PO known, barcodes not resolved yet — the scrape queue, scrape-scoped.
    db.style.count({
      where: {
        poNumber: { not: null },
        eanStatus: { in: ["PENDING", "RESOLVING"] },
        ...(scrapeCutoff !== null ? { poSeq: { gte: scrapeCutoff } } : {}),
      },
    }),
    db.style.count({
      where: {
        poNumber: { not: null },
        eanStatus: { in: ["ERROR", "PO_NOT_FOUND", "PO_FOUND_NO_EANS"] },
        eanAttempts: { gte: MAX_EAN_ATTEMPTS },
      },
    }),
    // 2. Complete styles the generation sweep will actually pick up.
    db.style.count({
      where: {
        status: "READY",
        prodSpec: { is: { active: true } },
        jobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } },
        ...genWindow,
      },
    }),
    genFloatCandidates.length > 0
      ? db.style.count({
          where: {
            id: { in: genFloatCandidates },
            status: { in: ["PENDING", "READY"] },
            jobs: { none: { status: { in: ["QUEUED", "RUNNING"] } } },
          },
        })
      : 0,
    // 3. A job in flight right now.
    db.style.count({ where: { jobs: { some: { status: { in: ["QUEUED", "RUNNING"] } } } } }),
    // 4. Generated, waiting on a reviewer decision.
    db.style.count({ where: { jobs: { some: { status: "AWAITING_REVIEW" } } } }),
    // 5. Approved outputs captured for the supplier, not (fully) uploaded yet.
    db.supplierSendQueueItem.count({
      where: { sentAt: null, sharePointStatus: { not: "UPLOADED" } },
    }),
    db.supplierSendQueueItem.count({
      where: {
        sentAt: null,
        sharePointStatus: "FAILED",
        pushAttempts: { gte: MAX_PUSH_ATTEMPTS },
      },
    }),
    // 6. In the supplier folder, waiting for tonight's digest.
    db.supplierSendQueueItem.count({ where: { sentAt: null, sharePointStatus: "UPLOADED" } }),
    // 7. Sent — the last 7 days as the "it's flowing" proof.
    db.supplierSendQueueItem.count({
      where: { sentAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    }),
    // Parked: pre-generation styles below the generation cutoff — deliberately
    // untouched by the sweeps.
    genCutoff !== null
      ? db.style.count({
          where: { status: { in: ["PENDING", "READY"] }, poSeq: { lt: genCutoff } },
        })
      : 0,
  ]);

  const stages: PipelineStage[] = [
    {
      key: "barcodes",
      label: "Awaiting barcodes",
      count: awaitingBarcodes,
      floated: floatedEan,
      hint: "PO known, EANs not scraped yet" + (scrapeCutoff !== null ? ` (PO ≥ ${scrapeCutoff})` : ""),
      href: "/po-eans",
    },
    {
      key: "ready",
      label: "Ready to generate",
      count: readyToGenerate,
      floated: floatedGen,
      hint: "complete, in the sweep's scope, no job in flight",
      href: "/styles",
    },
    {
      key: "generating",
      label: "Generating now",
      count: generating,
      floated: 0,
      hint: "a job is queued or rendering",
      href: "/jobs",
    },
    {
      key: "review",
      label: "Awaiting review",
      count: awaitingReview,
      floated: 0,
      hint: "generated, waiting on a decision",
      href: "/reviews",
    },
    {
      key: "upload",
      label: "Approved — awaiting upload",
      count: awaitingUpload,
      floated: floatedUpload,
      hint: supplierSend
        ? "queued for the supplier's SharePoint folder"
        : "queued; uploads wait for the supplier-sending toggle",
      href: "/settings/approved",
    },
    {
      key: "digest",
      label: "Uploaded — awaiting digest",
      count: uploadedAwaitingDigest,
      floated: 0,
      hint: "in the supplier folder, goes in tonight's email",
      href: "/settings/approved",
    },
    {
      key: "sent",
      label: "Sent to suppliers (7 days)",
      count: sentLast7,
      floated: 0,
      hint: "outputs delivered via digest",
      href: "/settings/approved",
    },
  ];

  return {
    scrapeCutoff,
    genCutoff,
    supplierCutoff,
    parkedBelowGen,
    switches: { autoScrape, autoGen, supplierSend },
    stages,
  };
}
