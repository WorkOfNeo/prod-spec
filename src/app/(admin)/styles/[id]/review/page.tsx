import { cache, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin, canReview } from "@/lib/roles";
import { OutputFieldEditor } from "./output-field-editor";
import { OutputEditDialog } from "./output-edit-dialog";
import { OutputBulkActions } from "./output-bulk-actions";
import { SupplierPushActions } from "./supplier-push-actions";
import { ReviewClaim } from "./claim-review";
import { ReviewLeaveGuard } from "./leave-guard";
import { ReviewCartonCustomize } from "./review-carton-customize";
import { UndoIgnoreButton } from "./undo-ignore-button";
import { ReviewWorkspace } from "./review-workspace";
import type { ProofItem, ReviewItem, ThreadView, TicketStatus } from "./review-types";
import { RunOutputButton } from "../run-output-button";
import { RerunButton } from "../rerun-button";
import { ManualTrimsPanel } from "../manual-trims-panel";
import { groupByDocType } from "../doc-type-groups";
import { LogStyleView } from "@/components/log-style-view";
import { PageHeader } from "@/components/ui/page-header";
import { Pill, type PillTone } from "@/components/ui/pill";
import { loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { getVariant } from "@/lib/pdf/template-registry";
import { applyFieldOverrides } from "@/lib/pdf/pins";
import { isPinnableField } from "@/lib/pdf/pins-meta";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import type { StyleData } from "@/lib/pdf/types";
import type { DocumentLine } from "@/lib/output-layouts/lines";
import { mergeLineValues } from "@/lib/outputs/output-line-values";
import { reviewFollowThroughEnabled } from "@/lib/review-flow/flags";
import { baseVariantKey } from "@/lib/tickets/orphan";
import { splitTicketComment } from "@/lib/tickets/thread";
import { COVER_VARIANT_KEY, GENERAL_INFO_VARIANT_KEY } from "@/lib/pdf/bundle-page-keys";
import {
  getCurrentOutputsForStyle,
  rollupOutputSlots,
  outputAnchor,
  type CurrentOutput,
} from "@/lib/outputs/current-outputs";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import {
  effectiveOutputDims,
  listActiveInfoAreaSizes,
  loadInfoAreaSizeMap,
} from "@/lib/prod-spec/info-area";
import {
  ReviewInfoAreaSizePicker,
  type InfoAreaSizeOption,
} from "./info-area-size-picker";
import { mondayItemUrl } from "@/lib/monday/url";
import { styleReadinessNotice } from "@/lib/styles/readiness-notice";
import {
  OutputReadinessNotice,
  ReadinessPill,
  type ReadinessHrefs,
} from "@/components/output-readiness-notice";

export const dynamic = "force-dynamic";

// The review screen reads the STYLE's current outputs — the latest asset per
// (variantKey) across all jobs, lined up against the declared output set — so
// outputs generated in different runs roll up here together. Decisions stay
// per output; the bulk shortcuts loop the per-output endpoints.
//
// This page loads and decides; ReviewWorkspace (client) lays it out as a list,
// the selected proof, and the comments + decision for it. The rejection log's
// threads come along per output, so a reviewer sees what was said before.

// List sections that aren't document types.
const MISSING_GROUP = "Not generated, missing data";
const HISTORY_GROUP = "Earlier generations";
const EXCLUDED_GROUP = "Excluded or ignored";
const MANUAL_GROUP = "Supplied by hand";
const MANUAL_KEY = "__manual-trims";

// The page's style read. cache() is request-scoped, so generateMetadata (which
// only wants the name) shares this one query instead of issuing its own.
const loadStyle = cache(async (id: string) =>
  db.style.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      poNumber: true,
      poFileName: true,
      eanStatus: true,
      eanAttempts: true,
      mondayBoardId: true,
      mondayItemId: true,
      businessArea: true,
      customer: { select: { name: true } },
      businessAreaRef: { select: { name: true } },
      supplier: { select: { sharepointUrl: true } },
      prodSpec: { select: { id: true, outputs: true } },
    },
  }),
);

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const style = await loadStyle(id);
  return { title: style ? `Review ${style.name}` : "Review" };
}

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { loadStyleFieldValues } = await import("@/lib/outputs/output-field-values");
  const { loadStyleLineValues } = await import("@/lib/outputs/output-line-values");
  // Test-phase follow-through (claim popup/chip + leave guard) — bound to the
  // newest still-pending generation job for this style, with style-level counts.
  const followThrough = reviewFollowThroughEnabled();

  // Every read on this page is keyed on the id alone, so they go out as ONE
  // wave. A missing style still 404s right after it; the ticket read is simply
  // unused when the page takes the "No outputs to review" early return.
  const [
    { session, role },
    style,
    outputs,
    docTypeLabels,
    fieldValuesByKey,
    lineValuesByKey,
    renderContext,
    infoAreaSizes,
    infoAreaSizeMap,
    inflightJobs,
    pendingJob,
    tickets,
  ] = await Promise.all([
    getSessionWithRole(),
    loadStyle(id),
    getCurrentOutputsForStyle(id),
    loadDocTypeLabels(),
    loadStyleFieldValues(id),
    // Reviewer LINE rewrites — the catch-all editor's current values.
    loadStyleLineValues(id),
    // StyleData for pre-filling the field editor with each output's current
    // resolved values. Fail-soft: a preview-build hiccup just means blank
    // pre-fills, never a broken review page.
    loadStyleRenderContext(id).catch(() => null),
    // Info-area print sizes: the active list feeds the in-review picker;
    // the full map resolves the current pick (even a deactivated one).
    listActiveInfoAreaSizes(),
    loadInfoAreaSizeMap(),
    // Is a generation already running? The same condition /rerun enforces —
    // asking here just disables the button instead of answering 409.
    db.job.count({ where: { styleId: id, status: { in: ["QUEUED", "RUNNING"] } } }),
    followThrough
      ? db.job.findFirst({
          where: { styleId: id, status: "AWAITING_REVIEW" },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            reviewClaimedById: true,
            reviewClaimedAt: true,
            reviewClaimedBy: { select: { name: true, email: true } },
          },
        })
      : null,
    // The style's rejection-log threads — the comments shown per output, and
    // the FIXED ones that keep an older rejection in the main view.
    db.rejectionTicket.findMany({
      where: { styleId: id },
      orderBy: { createdAt: "desc" },
      take: 300,
      select: {
        id: true,
        status: true,
        variantKey: true,
        comment: true,
        createdAt: true,
        updatedAt: true,
        reportedBy: { select: { name: true, email: true } },
      },
    }),
  ]);
  if (!style) notFound();

  // Push-to-supplier is an ADMIN-only action (no REVIEWER) — distinct from the
  // approve/reject gate (canReview). The endpoints enforce the same.
  const canPush = isAdmin(role);

  const styleData = renderContext?.styleData ?? null;
  const rollup = rollupOutputSlots(outputs);
  // Reviewers (ADMIN or REVIEWER) may fill/override output fields inline; other
  // viewers see the fields read-only. The endpoint enforces the same gate.
  const canEditFields = canReview(role);

  // The shared, role-aware Output Readiness Notice — one model that folds the
  // whole pipeline (SharePoint → PO → EANs → fields → generation → review) into
  // a headline pill + step ladder.
  const prodSpecOutputs = parseProdSpecOutputs(style.prodSpec?.outputs ?? []);
  const viewerRole = isAdmin(role) ? "ADMIN" : "REVIEWER";
  const notice = styleReadinessNotice(
    {
      eanStatus: style.eanStatus,
      eanAttempts: style.eanAttempts,
      poNumber: style.poNumber,
      poFileName: style.poFileName,
      hasProdSpec: style.prodSpec != null,
      prodSpecHasOutputs: prodSpecOutputs.some((o) => o.enabled !== false),
      currentOutputs: outputs,
    },
    viewerRole,
  );
  const prodSpecHref = style.prodSpec ? `/prod-specs/${style.prodSpec.id}` : undefined;
  const mondayHref = mondayItemUrl(style.mondayBoardId, style.mondayItemId);
  const readinessHrefs: ReadinessHrefs = {
    openPoEans: "/po-eans",
    ...(mondayHref ? { openMonday: mondayHref } : {}),
    ...(prodSpecHref
      ? { openProdSpec: prodSpecHref, setBusinessArea: prodSpecHref, pinFieldInSpec: prodSpecHref }
      : {}),
    ...(style.supplier?.sharepointUrl
      ? { openSuppliersDrive: style.supplier.sharepointUrl }
      : {}),
  };

  const businessArea = style.businessAreaRef?.name ?? style.businessArea ?? null;
  const styleContext = [
    style.name,
    style.customer.name,
    businessArea,
    style.poNumber ? `PO ${style.poNumber}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Reviewable = generated and not currently regenerating.
  const reviewable = outputs.filter((o) => o.jobAssetId != null && o.state !== "GENERATING");
  // Excluded = deliberately skipped by a doc-type keyword rule (decided, not
  // pending) — listed separately so they don't read as "still waiting".
  const excludedOutputs = outputs.filter((o) => o.state === "EXCLUDED");
  // Outputs that COULD NOT be generated because required fields are blank on
  // Monday. Readiness-gating (PR #152) means these never produced a (blank)
  // PDF, so there's no proof to show — instead of silently hiding them, they
  // list the fields to fill in.
  const missingFieldOutputs = outputs.filter(
    (o) => o.state === "AWAITING_DATA" && o.missing.length > 0,
  );
  const pendingReviewable = reviewable.filter((o) => o.reviewStatus === "PENDING_REVIEW");
  const approveAssetIds = pendingReviewable
    .filter((o) => o.placeholderCount === 0 && o.jobAssetId)
    .map((o) => o.jobAssetId as string);
  const rejectAssetIds = pendingReviewable.map((o) => o.jobAssetId as string);
  // Bundle framing (cover / general info) regenerates with every run — it
  // can't be ignored per style, so it's excluded from "Ignore all" and its
  // decision hides the Ignore option.
  const ignorableOutput = (o: CurrentOutput) => {
    const b = baseVariantKey(o.variantKey);
    return b !== COVER_VARIANT_KEY && b !== GENERAL_INFO_VARIANT_KEY;
  };
  const ignoreAssetIds = pendingReviewable
    .filter(ignorableOutput)
    .map((o) => o.jobAssetId as string);
  const blockedCount = pendingReviewable.filter((o) => o.placeholderCount > 0).length;
  // Admin push-to-supplier targets APPROVED, print-safe outputs only.
  const pushableCount = reviewable.filter(
    (o) => o.reviewStatus === "APPROVED" && o.placeholderCount === 0 && o.jobAssetId,
  ).length;

  const notGeneratedCount = rollup.awaitingData + rollup.readyToGenerate;
  const tally = [
    rollup.approved > 0 ? `${rollup.approved} approved` : null,
    rollup.rejected > 0 ? `${rollup.rejected} rejected` : null,
    rollup.toReview > 0 ? `${rollup.toReview} to review` : null,
    rollup.blocked > 0 ? `${rollup.blocked} blocked` : null,
    rollup.generating > 0 ? `${rollup.generating} generating` : null,
    notGeneratedCount > 0 ? `${notGeneratedCount} not generated` : null,
    rollup.excluded > 0 ? `${rollup.excluded} excluded` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const decided = reviewable.filter(
    (o) => o.reviewStatus === "APPROVED" || o.reviewStatus === "REJECTED",
  ).length;
  const pending = pendingReviewable.length;
  const claimedByMe =
    pendingJob?.reviewClaimedById != null && pendingJob.reviewClaimedById === session?.user.id;

  if (outputs.length === 0) {
    return (
      <div className="px-6 py-5">
        <LogStyleView styleId={id} surface="REVIEW" />
        <PageHeader
          back={{ href: `/styles/${id}`, label: style.name }}
          title="No outputs to review"
          meta="This style has no enabled outputs on its prod spec yet."
        />
      </div>
    );
  }

  // ── Comment threads ──────────────────────────────────────────────────────
  // One ticket per (style × output) thread; the open one carries the live
  // conversation, resolved ones are history. Images are served behind the
  // admin log, so reviewers see how many there are, not the images.
  const attachmentsByTicket = new Map<string, { id: string; fileName: string }[]>();
  if (tickets.length > 0) {
    try {
      const atts = await db.rejectionAttachment.findMany({
        where: { ticketId: { in: tickets.map((t) => t.id) } },
        orderBy: { createdAt: "asc" },
        select: { id: true, ticketId: true, fileName: true },
      });
      for (const a of atts) {
        const list = attachmentsByTicket.get(a.ticketId) ?? [];
        list.push({ id: a.id, fileName: a.fileName });
        attachmentsByTicket.set(a.ticketId, list);
      }
    } catch {
      // rejection_attachments not deployed yet — threads without images.
    }
  }
  const threadsByKey = new Map<string, ThreadView[]>();
  for (const t of tickets) {
    if (!t.variantKey) continue; // legacy whole-job tickets aren't one output's thread
    const atts = attachmentsByTicket.get(t.id) ?? [];
    const view: ThreadView = {
      ticketId: t.id,
      status: t.status as TicketStatus,
      reporter: t.reportedBy.name || t.reportedBy.email,
      createdAtIso: t.createdAt.toISOString(),
      updatedAtIso: t.updatedAt.toISOString(),
      entries: splitTicketComment(t.comment),
      attachments: isAdmin(role)
        ? atts.map((a) => ({ id: a.id, fileName: a.fileName, url: `/api/admin/rejection-tickets/${t.id}/attachments/${a.id}` }))
        : [],
      attachmentCount: atts.length,
    };
    const list = threadsByKey.get(t.variantKey) ?? [];
    list.push(view); // newest first — the query's order
    threadsByKey.set(t.variantKey, list);
  }
  const openThread = (key: string) => threadsByKey.get(key)?.find((t) => t.status !== "RESOLVED") ?? null;
  const pastThreads = (key: string) => (threadsByKey.get(key) ?? []).filter((t) => t.status === "RESOLVED");

  // Outputs the admin marked FIXED on the rejection log ("ready for re-review").
  // These must stay in the MAIN view so the reviewer can act on them even if the
  // latest asset is an older-generation rejection that wasn't re-rendered — the
  // "locate on /review when marked fixed" guard (the rejection-log History split
  // relies on this so a fixed thread is always findable here).
  const fixedTicketBases = new Set(
    tickets.filter((t) => t.status === "FIXED").map((t) => baseVariantKey(t.variantKey)),
  );
  const hasFixedTicket = (o: CurrentOutput) =>
    fixedTicketBases.has(baseVariantKey(o.variantKey));

  // History = REJECTED outputs from an EARLIER run only. They stay fully
  // reviewable but fold into "Earlier generations" so the main list isn't
  // cluttered by stale rejections.
  //
  // APPROVED outputs are NEVER history: with durable approval a full re-run
  // preserves them instead of regenerating (so their latest asset is from an
  // earlier job — fromLatestGeneration is false), but they are the CURRENT
  // approved state and must stay in the main view so the reviewer can always
  // see them.
  //
  // Anything still pending — or marked fixed and awaiting re-review — is also
  // never history, even from an older job.
  const isHistoryOutput = (o: CurrentOutput) =>
    o.reviewStatus === "REJECTED" && !o.fromLatestGeneration && !hasFixedTicket(o);
  const history = reviewable.filter(isHistoryOutput);
  const current = reviewable.filter((o) => !isHistoryOutput(o));

  // Info-area outputs get a print-size picker (reviewers operate here, not on
  // the style page). Resolved per output: the ProdSpec entry carries the pick;
  // the size map names it even if since deactivated.
  const prodSpecId = style.prodSpec?.id ?? null;
  const infoAreaFor = (o: CurrentOutput): InfoAreaProps | null => {
    if (!prodSpecId || !canEditFields) return null;
    const baseKey = o.variantKey.split("#")[0];
    if (!getVariant(baseKey)?.isInfoArea) return null;
    const entry = prodSpecOutputs.find((x) => x.variantKey === baseKey);
    if (!entry) return null;
    const dims = effectiveOutputDims(entry, true, infoAreaSizeMap);
    return {
      prodSpecId,
      variantKey: baseKey,
      sizes: infoAreaSizes,
      currentSizeId: entry.infoAreaSizeId ?? null,
      currentSizeName: entry.infoAreaSizeId
        ? (infoAreaSizeMap.get(entry.infoAreaSizeId)?.name ?? null)
        : null,
      widthMm: dims.widthMm,
      heightMm: dims.heightMm,
    };
  };

  // ── The list, and what each item opens ───────────────────────────────────
  const items: ReviewItem[] = [];
  const panels: Record<string, ReactNode> = {};
  const tools: Record<string, ReactNode> = {};

  const addProof = (o: CurrentOutput, group: string, isHistory: boolean) => {
    const thread = openThread(o.variantKey);
    const item = proofItem(o, group, thread, pastThreads(o.variantKey));
    items.push(item);
    tools[o.variantKey] = (
      <OutputTools
        o={o}
        styleId={style.id}
        // The earlier-generation proofs are reference: no field or line editing.
        canEditFields={canEditFields && !isHistory}
        styleData={styleData}
        fieldValuesByKey={fieldValuesByKey}
        lineValuesByKey={lineValuesByKey}
        infoArea={isHistory ? null : infoAreaFor(o)}
      />
    );
  };

  for (const group of groupByDocType<CurrentOutput>(current, docTypeLabels)) {
    for (const o of group.items) addProof(o, group.label, false);
  }

  for (const o of missingFieldOutputs) {
    items.push({
      kind: "panel",
      key: o.variantKey,
      anchor: outputAnchor(o.variantKey),
      name: o.name,
      group: MISSING_GROUP,
      tone: "warn",
      statusLabel: `Missing ${o.missing.length} field${o.missing.length === 1 ? "" : "s"}`,
    });
    panels[o.variantKey] = (
      <MissingDataPanel
        o={o}
        styleId={style.id}
        canEditFields={canEditFields}
        overrides={fieldValuesByKey.get(o.variantKey) ?? {}}
        mondayHref={mondayHref ?? undefined}
      />
    );
  }

  for (const o of history) addProof(o, HISTORY_GROUP, true);

  for (const o of excludedOutputs) {
    items.push({
      kind: "panel",
      key: o.variantKey,
      anchor: outputAnchor(o.variantKey),
      name: o.name,
      group: EXCLUDED_GROUP,
      tone: "neutral",
      statusLabel: o.ignored ? "Ignored for this style" : "Excluded by a rule",
    });
    panels[o.variantKey] = <ExcludedPanel o={o} styleId={style.id} />;
  }

  // The documents this app does NOT produce. A reviewer deciding on a style
  // asks one question — is everything here? — and the generated proofs only
  // answer half of it. The lines the buyer named on the order but nobody
  // generated are answered here, and they are just as much a reason to hold an
  // approval. Same panel as the style page's Review tab, deliberately: two
  // renderings of "what is still missing" would drift.
  items.push({
    kind: "panel",
    key: MANUAL_KEY,
    anchor: "manual-trims",
    name: "Manually supplied packaging",
    group: MANUAL_GROUP,
    tone: "neutral",
    statusLabel: "",
  });
  panels[MANUAL_KEY] = (
    <section>
      <h2 className="text-ink text-[14px] font-semibold">Manually supplied packaging</h2>
      <p className="text-muted mt-1 mb-4 text-[13px]">
        Packaging the buyer named on the order that this app doesn&rsquo;t generate.
      </p>
      <ManualTrimsPanel styleId={style.id} />
    </section>
  );

  // The pipeline ladder starts open when something in it is blocked, so a
  // reviewer sees why before deciding.
  const pipelineBlocked = notice.steps.some((s) => s.tone === "red");

  return (
    <div className="flex flex-col xl:h-[calc(100dvh-3rem)] xl:overflow-hidden">
      <LogStyleView styleId={id} surface="REVIEW" />
      {followThrough ? (
        // Per-style key now — leaving with some-decided/some-pending intercepts.
        <ReviewLeaveGuard
          jobId={style.id}
          decided={decided}
          pending={pending}
          claimedByMe={claimedByMe}
          styleContext={styleContext}
        />
      ) : null}
      <div className="shrink-0 px-6 pt-4 pb-4">
        <PageHeader
          back={{ href: `/styles/${id}`, label: style.name }}
          title={<>Review · {style.name}</>}
          meta={
            <>
              {style.customer.name}
              {businessArea ? <> · {businessArea}</> : null}
              {style.poNumber ? <> · PO {style.poNumber}</> : null}
              {" · "}
              {rollup.total} output{rollup.total === 1 ? "" : "s"}
              {tally ? <span className="text-faint"> · {tally}</span> : null}
            </>
          }
          actions={
            <>
              {/* Whole-style re-run, the same button and endpoint as the style
                  page header — so a reviewer who fixed the data upstream doesn't
                  have to bounce back there to regenerate. Safe next to the
                  decisions because a FULL re-run skips already-approved outputs
                  (durable approval) — only the undecided ones re-render. */}
              {canEditFields ? <RerunButton styleId={style.id} disabled={inflightJobs > 0} /> : null}
              {canPush && pushableCount > 0 ? (
                <SupplierPushActions styleId={style.id} pushableCount={pushableCount} />
              ) : null}
              <OutputBulkActions
                styleId={style.id}
                styleContext={styleContext}
                approveAssetIds={approveAssetIds}
                rejectAssetIds={rejectAssetIds}
                ignoreAssetIds={ignoreAssetIds}
                blockedCount={blockedCount}
              />
            </>
          }
        >
          {followThrough && pendingJob ? (
            <ReviewClaim
              jobId={pendingJob.id}
              pendingCount={pending}
              claimedByName={
                pendingJob.reviewClaimedBy
                  ? pendingJob.reviewClaimedBy.name || pendingJob.reviewClaimedBy.email
                  : null
              }
              claimedByMe={claimedByMe}
              claimedAtIso={pendingJob.reviewClaimedAt?.toISOString() ?? null}
              styleContext={styleContext}
            />
          ) : null}
          {/* The shared Output Readiness Notice, folded to its pill: source /
              PO / SharePoint → spec → fields → generation → review. */}
          <details className="group mt-2" {...(pipelineBlocked ? { open: true } : {})}>
            <summary className="text-muted hover:text-ink inline-flex cursor-pointer list-none items-center gap-1.5 text-[12px] [&::-webkit-details-marker]:hidden">
              <ChevronRight size={13} aria-hidden="true" className="transition-transform group-open:rotate-90" />
              Pipeline
              <ReadinessPill notice={notice} />
            </summary>
            <div className="mt-3 max-w-3xl">
              <OutputReadinessNotice notice={notice} role={viewerRole} hrefs={readinessHrefs} />
            </div>
          </details>
        </PageHeader>
      </div>

      <ReviewWorkspace
        styleId={style.id}
        styleContext={styleContext}
        canPush={canPush}
        items={items}
        panels={panels}
        tools={tools}
        collapsedGroups={[HISTORY_GROUP, EXCLUDED_GROUP]}
        progress={{ decided, total: reviewable.length }}
      />
    </div>
  );
}

// Where an output stands, as the list and its pill say it.
function proofStatus(o: CurrentOutput, thread: ThreadView | null): { tone: PillTone; label: string } {
  if (o.reviewStatus === "APPROVED") return { tone: "good", label: "Approved" };
  if (thread?.status === "FIXED") return { tone: "accent", label: "Fixed, check again" };
  if (o.reviewStatus === "REJECTED") return { tone: "bad", label: "Changes requested" };
  if (o.placeholderCount > 0) return { tone: "warn", label: "Blocked by placeholders" };
  return { tone: "neutral", label: "To review" };
}

function proofItem(o: CurrentOutput, group: string, thread: ThreadView | null, past: ThreadView[]): ProofItem {
  const baseKey = baseVariantKey(o.variantKey);
  const variant = getVariant(baseKey);
  const status = proofStatus(o, thread);
  return {
    kind: "proof",
    key: o.variantKey,
    anchor: outputAnchor(o.variantKey),
    name: o.name,
    group,
    tone: status.tone,
    statusLabel: status.label,
    assetId: o.jobAssetId as string,
    fileName: o.fileName,
    status: o.reviewStatus ?? "PENDING_REVIEW",
    reviewedAtIso: o.reviewedAt?.toISOString() ?? null,
    placeholderCount: o.placeholderCount,
    // `v` isn't read by the route — it changes when the asset's bytes are
    // rewritten in place (a cover rebuilt after an approval), so the iframe
    // reloads on router.refresh() instead of keeping the page it already shows.
    previewUrl: `/api/admin/jobs/${o.jobId}/preview?variantKey=${encodeURIComponent(o.variantKey)}${o.assetVersion ? `&v=${o.assetVersion}` : ""}`,
    // Framing pages (cover / general info) regenerate every run — not ignorable.
    canIgnore: baseKey !== COVER_VARIANT_KEY && baseKey !== GENERAL_INFO_VARIANT_KEY,
    chips: [variant?.cartonNumbering ? "X of Y" : null, variant?.multipleStyles ? "Multi-style" : null].filter(
      (c): c is string => c !== null,
    ),
    thread,
    pastThreads: past,
  };
}

// The StyleData ONE document renders from: the per-row style for a multi-doc
// PDF (colour / carton EAN differ per PDF) with the shared whole-output field
// override folded in, so it matches what actually printed. Shared by the field
// editor's pre-fill and the line editor's resolved values — they must agree.
function documentStyle(
  variantKey: string,
  styleData: StyleData | null,
  fieldValuesByKey: ReadonlyMap<string, Record<string, string>>,
): StyleData | null {
  if (!styleData) return null;
  const baseKey = variantKey.split("#")[0];
  const variant = getVariant(baseKey);
  let src = styleData;
  const hashIdx = variantKey.indexOf("#");
  if (hashIdx >= 0 && variant?.docStyles) {
    const suffix = variantKey.slice(hashIdx + 1);
    const match = variant.docStyles(styleData).find((d) => d.suffix === suffix);
    if (match) src = match.style;
    const baseOverride = fieldValuesByKey.get(baseKey);
    if (baseOverride) src = applyFieldOverrides(src, baseOverride);
  }
  return src;
}

// Rows for the catch-all line editor: every line THIS document prints, with the
// reviewer's rewrites already folded in (base ∪ per-document, per-document
// winning — the same precedence the renderer applies), resolved against the
// same StyleData the field editor pre-fills from.
function outputLineEditorProps(
  variantKey: string,
  styleData: StyleData | null,
  fieldValuesByKey: ReadonlyMap<string, Record<string, string>>,
  lineValuesByKey: ReadonlyMap<string, Record<string, string>>,
): { lines: DocumentLine[]; isMultiDoc: boolean } {
  const baseKey = variantKey.split("#")[0];
  const variant = getVariant(baseKey);
  const src = documentStyle(variantKey, styleData, fieldValuesByKey);
  if (!variant?.lines || !src) return { lines: [], isMultiDoc: false };
  const overrides = mergeLineValues(
    lineValuesByKey.get(baseKey),
    variantKey === baseKey ? undefined : lineValuesByKey.get(variantKey),
  );
  return {
    lines: variant.lines(src, overrides),
    isMultiDoc: (variant.docStyles?.(styleData!)?.length ?? 1) > 1,
  };
}

// Props for the info-area print-size picker — null on non-info-area outputs,
// on earlier-generation proofs, and for viewers without the review role.
type InfoAreaProps = {
  prodSpecId: string;
  variantKey: string;
  sizes: InfoAreaSizeOption[];
  currentSizeId: string | null;
  currentSizeName: string | null;
  widthMm: number;
  heightMm: number;
};

// What a reviewer can change on one output without leaving the review: the
// carton set, the info-area print size, any printed line, or a re-run of just
// this output. Folded under the decision ("Change it yourself").
function OutputTools({
  o,
  styleId,
  canEditFields,
  styleData,
  fieldValuesByKey,
  lineValuesByKey,
  infoArea,
}: {
  o: CurrentOutput;
  styleId: string;
  canEditFields: boolean;
  styleData: StyleData | null;
  fieldValuesByKey: ReadonlyMap<string, Record<string, string>>;
  lineValuesByKey: ReadonlyMap<string, Record<string, string>>;
  infoArea: InfoAreaProps | null;
}) {
  const baseKey = baseVariantKey(o.variantKey);
  // Carton-capable outputs (numbering / multi-style) get an in-review Customize
  // action — regenerate the set in place and re-review it. Capability + print
  // dims come from the layout variant; the registry is already loaded by
  // getCurrentOutputsForStyle, so getVariant resolves here.
  const variant = getVariant(baseKey);
  const cartonCapable = Boolean(variant && (variant.cartonNumbering || variant.multipleStyles));
  const framing = baseKey === COVER_VARIANT_KEY || baseKey === GENERAL_INFO_VARIANT_KEY;
  return (
    <>
      {/* Document editor — opens the side-by-side dialog: every line this
          document prints on the left, a live render on the right. Keyed by
          o.variantKey, so a single PDF of a repeat-per-EAN output is edited on
          its own by default (the dialog offers "apply to every PDF"). Framing
          pages (cover / general info) carry no editable lines. */}
      {canEditFields && !framing
        ? (() => {
            const { lines, isMultiDoc } = outputLineEditorProps(o.variantKey, styleData, fieldValuesByKey, lineValuesByKey);
            return (
              <OutputEditDialog
                styleId={styleId}
                variantKey={o.variantKey}
                baseKey={baseKey}
                outputName={o.name}
                lines={lines}
                isMultiDoc={isMultiDoc}
                widthMm={infoArea?.widthMm ?? variant?.defaultWidthMm ?? 100}
                heightMm={infoArea?.heightMm ?? variant?.defaultHeightMm ?? 100}
              />
            );
          })()
        : null}
      {/* Info-area print size — saving re-runs this output so the proof shows
          the chosen size (including the "barcode won't scan at this size" chip
          when it can't fit). */}
      {infoArea ? (
        <div className="border-line rounded-md border [&>div]:border-t-0">
          <ReviewInfoAreaSizePicker
            styleId={styleId}
            prodSpecId={infoArea.prodSpecId}
            variantKey={infoArea.variantKey}
            sizes={infoArea.sizes}
            currentSizeId={infoArea.currentSizeId}
            currentSizeName={infoArea.currentSizeName}
            widthMm={infoArea.widthMm}
            heightMm={infoArea.heightMm}
            ready={o.missing.length === 0}
          />
        </div>
      ) : null}
      {cartonCapable && variant ? (
        <div>
          <ReviewCartonCustomize
            styleId={styleId}
            variantKey={baseKey}
            name={o.name}
            widthMm={variant.defaultWidthMm}
            heightMm={variant.defaultHeightMm}
            cartonNumbering={variant.cartonNumbering ?? false}
            multipleStyles={variant.multipleStyles ?? false}
          />
        </div>
      ) : null}
      {/* Single-output re-run (WS8) — change the data (wash-care, care label)
          then re-run just this output without touching the rest of the review.
          A scoped re-run regenerates even an approved output (explicit intent),
          so it comes back for a fresh decision. */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted text-[12px]">Changed the data? Re-run just this output.</span>
        <RunOutputButton
          styleId={styleId}
          variantKey={baseKey}
          ready={o.missing.length === 0}
          missingLabels={o.missing.map((m) => m.label)}
          label="Re-run"
        />
      </div>
    </>
  );
}

// An output that couldn't generate because required fields are blank: fill
// them here (reviewers) or on Monday.
function MissingDataPanel({
  o,
  styleId,
  canEditFields,
  overrides,
  mondayHref,
}: {
  o: CurrentOutput;
  styleId: string;
  canEditFields: boolean;
  overrides: Record<string, string>;
  mondayHref?: string;
}) {
  return (
    <section>
      <h2 className="text-ink text-[14px] font-semibold">{o.name}</h2>
      {canEditFields ? (
        <>
          <p className="text-muted mt-1 mb-4 text-[13px]">
            Couldn&apos;t generate, some data is missing. Fill it in and it&apos;ll render.
          </p>
          <div className="border-line bg-surface rounded-lg border p-4">
            <OutputFieldEditor
              styleId={styleId}
              variantKey={o.variantKey}
              outputName={o.name}
              submitLabel="Save & generate"
              fields={o.missing.filter((m) => isPinnableField(m.field)).map((m) => m.field)}
              locked={o.missing.filter((m) => !isPinnableField(m.field))}
              overrides={overrides}
              mondayHref={mondayHref}
            />
          </div>
        </>
      ) : (
        <>
          <p className="text-muted mt-1 mb-3 text-[13px]">
            Missing fields, so this output couldn&apos;t be generated. Fill these in on{" "}
            {mondayHref ? (
              <a href={mondayHref} target="_blank" rel="noopener noreferrer" className="text-accent-text underline">
                Monday
              </a>
            ) : (
              "Monday"
            )}
            {" "}and it generates automatically:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {o.missing.map((m) => (
              <Pill key={m.field} tone="warn">
                {m.label}
              </Pill>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// An output that won't be generated for this style: skipped by a doc-type
// rule, or ignored by a reviewer (undoable here).
function ExcludedPanel({ o, styleId }: { o: CurrentOutput; styleId: string }) {
  return (
    <section>
      <h2 className="text-ink text-[14px] font-semibold">{o.name}</h2>
      <p className="text-muted mt-1 text-[13px]">
        {o.ignored
          ? "Ignored for this style: skipped in generation, the SharePoint upload and the nightly email."
          : "Excluded by a document-type rule, so it won't be generated for this style."}
      </p>
      {o.exclusionReason ? <p className="text-ink mt-3 text-[13px]">{o.exclusionReason}</p> : null}
      {o.ignored ? (
        <div className="mt-4">
          <UndoIgnoreButton styleId={styleId} variantKey={o.variantKey.split("#")[0]} />
        </div>
      ) : null}
    </section>
  );
}
