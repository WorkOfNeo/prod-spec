import { cache, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import {
  resolveStyleSpecFields,
  resolveMappedField,
  STYLE_FIELD_LABELS,
  effectiveStyleItem,
  type ResolvedSpecField,
} from "@/lib/styles/resolved-fields";
import type { MondayItem } from "@/lib/monday/client";
import { getAutoGenerateEnabled } from "@/lib/settings/app-settings";
import { getSessionWithRole } from "@/lib/auth-server";
import { shareUrl } from "@/lib/supplier-share/share";
import { findMissingDetailFields } from "@/lib/styles/detail-fields";
import { computeReadiness, type Readiness } from "@/lib/styles/readiness";
import { computeEffectiveStatus, type EffectiveStatus } from "@/lib/styles/effective-status";
import { outputReadinessForStyle } from "@/lib/styles/output-readiness";
import { styleReadinessNotice } from "@/lib/styles/readiness-notice";
import { OutputReadinessNotice, type ReadinessHrefs } from "@/components/output-readiness-notice";
import { mondayItemUrl } from "@/lib/monday/url";
import { loadDocTypeExclusionRules, loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { loadIgnoredOutputKeys } from "@/lib/outputs/output-ignores";
import { getCurrentOutputsForStyle, rollupOutputSlots, outputAnchor } from "@/lib/outputs/current-outputs";
import { RerunButton } from "./rerun-button";
import { AlertTriangle, Check, ChevronRight, CircleCheck, CircleDashed, CircleX, ExternalLink, Pencil, X } from "lucide-react";
import { TabLinks, type TabLink } from "@/components/ui/tabs";
import { Pill, StatusDot, type PillTone } from "@/components/ui/pill";
import { buttonClass } from "@/components/ui/button";
import { StyleOutputCard, type StyleOutputCardProps } from "./style-output-card";
import { OutputsAccordion } from "./outputs-accordion";
import { ProdSpecTab } from "./prod-spec-tab";
import { ReviewTab } from "./review-tab";
import { HistoryTab, type HistoryFilter } from "./history-tab";
import { PipelineStrip, type PipelineStep } from "./pipeline-strip";
import { ResolvedFieldsCard, type ResolvedFieldRow } from "./resolved-fields-card";
import type { GalleryItem } from "./review-gallery";
import { splitTicketComment } from "@/lib/tickets/thread";
import { triggerLabel } from "@/lib/queue/trigger-labels";
import { docTypeLabel } from "@/lib/pdf/doc-types";
import { timeAgo } from "@/lib/time";
import { EanPanel } from "./ean-panel";
import { PoPreview } from "./po-preview";
import { type EanView, toEanSize } from "@/lib/po/ean-view";
import { parsePoScrapeSnapshot } from "@/lib/po/scrape-snapshot";
import { readUseStyleBoardColour } from "@/lib/po/ean-override-actions";
import type { AssetReviewStatus } from "@/generated/prisma/enums";
import { colorFromVariantLabel } from "@/lib/po/ean-format";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import {
  effectiveOutputDims,
  listActiveInfoAreaSizes,
  loadInfoAreaSizeMap,
} from "@/lib/prod-spec/info-area";
import { requiredFieldsForVariants, getVariant, defaultArtifactFileName } from "@/lib/pdf/template-registry";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { buildStyleData } from "@/lib/styles/render-context";
import { parseCustomerConfig } from "@/lib/customers/config";
import { SkipSupplierDeliveryBadge } from "@/components/skip-supplier-delivery-badge";
import { SupplierFolderStatus, type PoFolderDelivery } from "./supplier-folder-status";
import { RelatedRowsCard, loadRelatedRowsCardProps } from "./related-rows-card";
import { BackToStyles } from "./back-to-styles";
import { FolderReconcilePanel } from "./folder-reconcile-panel";
import { AskStylePanel } from "./ask-style-panel";
import { parseFolderMatches } from "@/lib/sharepoint/po-folder-matches";
import { LogStyleView } from "@/components/log-style-view";
import { applyFieldOverrides } from "@/lib/pdf/pins";
import { parseFieldOverrides, PINNABLE_FIELD_LABELS, type PinnableField } from "@/lib/pdf/pins-meta";
import { findFieldRule } from "@/lib/pdf/spec-fields";
import { ALL_PRINT_SPECS } from "@/lib/pdf/print-spec-catalog";
import { ORDER_NO_RULE } from "@/lib/pdf/templates/netto-dk-privatelabel/carton-marking";
import {
  loadWashcareSymbols,
  getWashcareSymbol,
  rejoinWashTokens,
} from "@/lib/pdf/washcare-symbols";
import {
  loadCareLabels,
  explainCareLabelVisibility,
  type PresentSymbol,
} from "@/lib/care-labels";

export const dynamic = "force-dynamic";

// The page's style read. cache() is request-scoped, so generateMetadata (which
// only wants the name) shares this one query instead of issuing its own.
const loadStyle = cache(async (id: string) =>
  db.style.findUnique({
    where: { id },
    // useStyleBoardColour is read separately (guarded, via readUseStyleBoardColour)
    // so this page keeps loading before the additive column is deployed
    // (db:deploy) — same hardening as the jobs.reviewEndedAt omit below.
    omit: { useStyleBoardColour: true },
    include: {
      customer: true,
      supplier: true,
      businessAreaRef: true,
      qrImage: { select: { name: true } },
      eans: { orderBy: { position: "asc" } },
      prodSpec: { include: { businessArea: true, suppliers: { include: { supplier: true } } } },
      jobs: {
        // reviewEndedAt isn't read on this page — omit it so the style page
        // keeps loading before the additive column is deployed (db:deploy).
        // Matches the hardening on the review screen / dashboard reads.
        omit: { reviewEndedAt: true },
        include: {
          // Pull asset METADATA only. The `pdf` Bytes column lives here
          // too and runs ~50-200 KB per asset — with 10 jobs × 2-3
          // assets each that's multiple MB pulled across the Railway
          // proxy on every page load. The preview endpoint loads the
          // single asset's bytes on demand when an iframe asks for it.
          assets: {
            select: {
              id: true,
              jobId: true,
              docType: true,
              variantKey: true,
              fileName: true,
              displayName: true,
              reviewStatus: true,
              rejectReason: true,
              reviewedAt: true,
              reviewedBy: { select: { email: true } },
              createdAt: true,
            },
          },
          reviewActions: { include: { user: true } },
          reviewClaimedBy: { select: { name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      },
    },
  }),
);

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const style = await loadStyle(id);
  return { title: style?.name ?? "Style" };
}

// The /styles status pill colours, in the theme's tones.
const STATUS_TONE: Record<EffectiveStatus["tone"], PillTone> = {
  zinc: "neutral",
  amber: "warn",
  green: "good",
  blue: "accent",
  purple: "accent",
  red: "bad",
};

// Data notes for an output card — currently the delivery-term switch:
// outputs whose order number branches on FOB/DDP get a chip naming the
// branch in effect, and an explicit "defaulting to DDP" note when the row
// carries no term yet (the default is correct, but must be conscious).
const SPEC_BY_VARIANT_KEY = new Map(ALL_PRINT_SPECS.map((s) => [s.id, s]));

function outputDataNotes(
  variantKey: string,
  item: MondayItem | null,
  mapping: ReturnType<typeof parseCustomerConfig>["columnMapping"],
): string[] {
  const orderRule =
    findFieldRule(SPEC_BY_VARIANT_KEY.get(variantKey), "customerOrderNumber") ??
    (variantKey === "netto-dk-privatelabel-carton-marking" ? ORDER_NO_RULE : null);
  if (!orderRule) return [];
  const term = resolveMappedField(item, mapping, "deliveryTerm").trim();
  if (!term) return ["no delivery term on row — defaulting to DDP → Contrast PO"];
  const branch = term.toUpperCase().includes("FOB") ? "customer order no" : "Contrast PO";
  return [`delivery term ${term} → prints ${branch}`];
}

type TabKey = "details" | "prod-spec" | "review" | "history";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "details", label: "Details" },
  // Prod Spec = config + the RUNS LIST (timestamps, counts, owner).
  // Review = the files themselves (grids up to 4 across).
  { key: "prod-spec", label: "Prod Spec" },
  { key: "review", label: "Review" },
  // History = the automation trace: sync → PO/EANs → jobs → review decisions
  // → supplier uploads → digest, one chronological timeline (self-fetching).
  { key: "history", label: "History" },
];

export default async function StyleDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; hist?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const tabParam = sp.tab;
  const historyFilter: HistoryFilter = sp.hist === "decisions" ? "decisions" : sp.hist === "automation" ? "automation" : "all";
  const tab: TabKey =
    tabParam === "prod-spec"
      ? "prod-spec"
      : tabParam === "review"
        ? "review"
        : tabParam === "history"
          ? "history"
          : "details";

  // ONE wave for every read that needs nothing but the id. These used to run
  // as ~20 sequential awaits — each a full round trip over the Railway proxy —
  // though none of them reads another's result. The style row is one of them:
  // a missing style still 404s right after the wave, its siblings' (now
  // unused) reads just settle first. Each loader keeps its own fail-soft
  // behaviour; nothing is caught collectively here.
  const [
    { role },
    style,
    recentAssets,
    supplierShare,
    sendQueueRows,
    autoGenerateEnabled,
    exclusionRules,
    exclusionLabels,
    ignoredOutputKeys,
    washcareSymbolMap,
    careLabels,
    infoAreaSizesActive,
    infoAreaSizeMap,
    useStyleBoardColour,
    currentOutputs,
    relatedRows,
    openTickets,
  ] = await Promise.all([
    getSessionWithRole(),
    loadStyle(id),
    // Latest generated asset per output variant — powers the realistic
    // thumbnail on each Outputs row. Queried directly instead of scanning
    // style.jobs: that window only holds the last 10 jobs, and per-output
    // reruns (one asset per job) push older outputs' assets out of it fast.
    // Metadata only — the PNG bytes come from the thumbnail endpoint.
    db.jobAsset.findMany({
      where: { job: { styleId: id }, variantKey: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true, jobId: true, variantKey: true, createdAt: true, updatedAt: true, reviewStatus: true },
      take: 400,
    }),
    // The style's durable supplier share (if approved at least once) — drives
    // the "Supplier link" panel on the prod-spec tab: the stable link + PIN to
    // forward, and whether the supplier has opened it. No other tab shows it.
    tab === "prod-spec"
      ? db.supplierShare.findUnique({
          where: { styleId: id },
          select: {
            token: true,
            pin: true,
            email: true,
            visitCount: true,
            firstVisitedAt: true,
            lastVisitedAt: true,
          },
        })
      : null,
    // This style's supplier-send queue rows — the ACTUAL SharePoint push outcome
    // for the "Supplier folder" panel (found + link / no PO folder / ambiguous).
    db.supplierSendQueueItem.findMany({
      where: { styleId: id },
      select: { variantKey: true, sharePointStatus: true, sharePointFolderUrl: true, sharePointFolderMatches: true },
    }),
    getAutoGenerateEnabled(),
    // Doc-type keyword exclusion rules + per-style operator ignores → mark
    // outputs skipped for this style (rule hit, or ignored from the review
    // surfaces), with a reason for the card.
    loadDocTypeExclusionRules(),
    loadDocTypeLabels(),
    loadIgnoredOutputKeys(id),
    // The catalogues behind the derived care instructions (careDerived).
    loadWashcareSymbols(),
    loadCareLabels(),
    // Info-area sizing catalogue: the active sizes the dropdown offers, plus a
    // full map (incl. inactive) to resolve a current pick's name + printed
    // dims. Resilient to a not-yet-deployed table (empty → custom only).
    listActiveInfoAreaSizes(),
    loadInfoAreaSizeMap(),
    readUseStyleBoardColour(id),
    // The style's current outputs for the Review tab — see currentFiles.
    getCurrentOutputsForStyle(id),
    // The lookalike-rows card's data — loaded here, not by the card itself
    // (see loadRelatedRowsCardProps for why).
    loadRelatedRowsCardProps(id),
    // Open rejection-log threads — the "Open" / "Fixed, check again" chips on
    // the outputs table and the comment counts in the Review gallery.
    db.rejectionTicket.findMany({
      where: { styleId: id, status: { not: "RESOLVED" } },
      select: { variantKey: true, status: true, comment: true },
    }),
    // Output Builder layouts resolve as variants in the readiness walks below.
    ensureLayoutVariantsLoaded(),
  ]);
  if (!style) notFound();

  // The output cards' generation actions (per-output Run, carton prints) stay
  // ADMIN-only — the API enforces it, and REVIEWERs (who can reach this page)
  // must not see buttons that would only 403. The header Generate / Re-run is
  // the exception: a reviewer opening a style that hasn't generated yet has no
  // review screen to work from, so kicking off a whole-style (re)generation is
  // part of reviewing (canReview) — the rerun endpoint enforces the same.
  const isAdmin = role === "ADMIN";
  const canRun = role === "ADMIN" || role === "REVIEWER";

  const latestAssetByVariant = new Map<
    string,
    { id: string; jobId: string; createdAt: Date; updatedAt: Date; reviewStatus: AssetReviewStatus }
  >();
  for (const a of recentAssets) {
    if (a.variantKey && !latestAssetByVariant.has(a.variantKey)) {
      latestAssetByVariant.set(a.variantKey, { id: a.id, jobId: a.jobId, createdAt: a.createdAt, updatedAt: a.updatedAt, reviewStatus: a.reviewStatus });
    }
    // Multi-document assets ("layout:<id>#<size>") also register under
    // their BASE key so the output card finds its latest asset.
    const base = a.variantKey?.split("#")[0];
    if (base && base !== a.variantKey && !latestAssetByVariant.has(base)) {
      latestAssetByVariant.set(base, { id: a.id, jobId: a.jobId, createdAt: a.createdAt, updatedAt: a.updatedAt, reviewStatus: a.reviewStatus });
    }
  }

  const latestJob = style.jobs[0];
  const missing = (style.missingFields as Array<{ id: string; label: string }>) ?? [];

  const supplierDelivery: PoFolderDelivery | null =
    sendQueueRows.length > 0
      ? {
          uploaded: sendQueueRows.filter((r) => r.sharePointStatus === "UPLOADED").length,
          noFolder: sendQueueRows.filter((r) => r.sharePointStatus === "NO_FOLDER").length,
          ambiguous: sendQueueRows.filter((r) => r.sharePointStatus === "AMBIGUOUS").length,
          other: sendQueueRows.filter(
            (r) => !["UPLOADED", "NO_FOLDER", "AMBIGUOUS"].includes(r.sharePointStatus),
          ).length,
          total: sendQueueRows.length,
          folderUrl:
            sendQueueRows.find((r) => r.sharePointStatus === "UPLOADED" && r.sharePointFolderUrl)
              ?.sharePointFolderUrl ?? null,
          ambiguousMatches: parseFolderMatches(
            sendQueueRows.find((r) => r.sharePointStatus === "AMBIGUOUS" && r.sharePointFolderMatches)
              ?.sharePointFolderMatches ?? null,
          ),
        }
      : null;

  // Required-field set for this style = the UNION of the fields each ENABLED
  // output on its ProdSpec declares it needs (template-registry). Single
  // source of truth for the readiness banner, the Resolved-fields highlight,
  // and the Prod Spec tab badge/checklist — a style needs exactly what the
  // labels it will print need.
  const enabledOutputs = parseProdSpecOutputs(style.prodSpec?.outputs ?? []).filter(
    (o) => o.enabled !== false,
  );
  const enabledVariantKeys = enabledOutputs.map((o) => o.variantKey);
  const outputEntryByKey = new Map(enabledOutputs.map((o) => [o.variantKey, o]));
  const requiredKeys = requiredFieldsForVariants(enabledVariantKeys);
  const customerConfig = parseCustomerConfig(style.customer.config);
  const reqMapping = customerConfig.columnMapping;
  const effItem = effectiveStyleItem(style) as MondayItem | null;
  const missingDetail = findMissingDetailFields(effItem, reqMapping, requiredKeys);
  const reqMissing = new Set(missingDetail.map((m) => m.field));
  const prodSpecReadiness = {
    total: requiredKeys.length,
    filled: requiredKeys.length - missingDetail.length,
    fields: requiredKeys.map((k) => ({ label: STYLE_FIELD_LABELS[k], ok: !reqMissing.has(k) })),
  };

  // Per-output readiness for the banner — each output generates as soon as
  // its own fields land. Customer mapping (empty override) matches reqMapping.
  const outputReadiness = style.prodSpec
    ? outputReadinessForStyle(
        {
          rawData: style.rawData,
          poNumber: style.poNumber,
          supplier: style.supplier,
          eans: style.eans,
          cartonEan: style.cartonEan,
          customer: { config: style.customer.config },
          prodSpec: { outputs: style.prodSpec.outputs, columnMapping: {} },
        },
        exclusionRules,
        exclusionLabels,
        ignoredOutputKeys,
      )
    : [];

  // The second and last wave: the two reads that need the style row itself.
  // Only the Prod Spec tab renders either, so the other tabs skip both — they
  // used to pay for a whole buildStyleData pass that nothing on them shows.
  const onProdSpecTab = tab === "prod-spec";
  const [outputsFilesPreview, candidateBusinessArea] = await Promise.all([
    // Pre-run files preview for the Prod Spec popover: per enabled output,
    // the PDFs the NEXT run would emit (count + resolved names). Assembled
    // from the SAME StyleData builder, pins and naming rules the runner
    // uses — repeat/split-aware for Output Builder layouts — so the
    // operator can verify the split settings against this style's actual
    // size/EAN rows before generating anything. qrImage is deliberately
    // null: the page only selects its name (the image is heavy) and file
    // naming never reads it.
    (async (): Promise<Array<{ variantKey: string; name: string; known: boolean; files: string[] }>> => {
      if (!onProdSpecTab || !style.prodSpec || enabledOutputs.length === 0) return [];
      const base = await buildStyleData(
        {
          id: style.id,
          rawData: style.rawData,
          poNumber: style.poNumber,
          cartonEan: style.cartonEan,
          mondayBoardId: style.mondayBoardId,
          supplier: style.supplier,
          eans: style.eans,
          customer: { name: style.customer.name, config: style.customer.config },
          qrImage: null,
        },
        style.prodSpec,
        parseCustomerConfig(style.customer.config),
      );
      return enabledOutputs.map((o) => {
        const variant = getVariant(o.variantKey);
        if (!variant) return { variantKey: o.variantKey, name: o.variantKey, known: false, files: [] };
        const renderStyle = applyFieldOverrides(base, o.fieldOverrides);
        const plan = variant.filesPreview?.(renderStyle) ?? [
          { suffix: null, fileName: variant.fileNameFor?.(renderStyle) ?? null },
        ];
        return {
          variantKey: o.variantKey,
          name: variant.name,
          known: true,
          files: plan.map(
            (p) => p.fileName ?? defaultArtifactFileName(variant, renderStyle.styleNumber, p.suffix),
          ),
        };
      });
    })(),
    // If the FK is missing but we have business-area text, see if any
    // active BusinessArea row matches by mondayValue or name. The tab
    // shows a "Link to <BA>" one-click action when there's a match.
    (async () => {
      if (!onProdSpecTab || style.businessAreaId) return null;
      const text = (style.businessArea ?? "").trim();
      if (!text) return null;
      const lowered = text.toLowerCase();
      const rows = await db.businessArea.findMany({ where: { active: true } });
      const match =
        rows.find((b) => b.mondayValue.toLowerCase() === lowered) ??
        rows.find((b) => b.name.toLowerCase() === lowered);
      return match ? { id: match.id, name: match.name, mondayValue: match.mondayValue } : null;
    })(),
  ]);

  // Derived care instructions for THIS style — the standard catalogue
  // filtered by the row's wash-care symbols, with per-line verdicts. The
  // same pure rule the renderer applies; shown so the operator sees WHAT
  // will print and WHY a line is dropped, before generating anything.
  const careDerived = (() => {
    const rawTokens = resolveMappedField(effItem, reqMapping, "washCare")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const tokens = rejoinWashTokens(rawTokens, washcareSymbolMap);
    const symbols = tokens.map((token) => {
      const resolved = getWashcareSymbol(washcareSymbolMap, token);
      return {
        token,
        name: resolved?.name ?? token,
        resolved: Boolean(resolved),
        present: (resolved
          ? { code: resolved.code, action: resolved.action, restrictive: resolved.restrictive }
          : { code: token, action: null, restrictive: false }) satisfies PresentSymbol,
      };
    });
    const present = symbols.map((s) => s.present);
    const lines = careLabels.map((label) => {
      const verdict = explainCareLabelVisibility(label, present);
      const reason =
        verdict.reason === "action-prohibited"
          ? `removed by ${verdict.matchedCodes.join(", ")} (prohibition)`
          : verdict.reason === "hidden-by"
            ? `hidden by ${verdict.matchedCodes.join(", ")}`
            : verdict.reason === "show-gate-unmet"
              ? "show-if not met"
              : verdict.reason === "show-gate-met"
                ? `shown by ${verdict.matchedCodes.join(", ")}`
                : "always shown";
      return { text: label.sourceText, visible: verdict.visible, reason };
    });
    return {
      symbols: symbols.map((s) => ({ name: s.name, resolved: s.resolved, token: s.token })),
      lines,
    };
  })();

  const infoAreaSizeOptions = infoAreaSizesActive.map((s) => ({
    id: s.id,
    name: s.name,
    widthMm: s.widthMm,
    heightMm: s.heightMm,
  }));

  // Per-output card props — live preview src, missing/pin/note chips, last
  // generated artifact. Computed here (not in DetailsTab) because they need
  // the effective item + mapping + parsed output entries.
  const outputCards: StyleOutputCardProps[] = outputReadiness.map((o) => {
    const asset = latestAssetByVariant.get(o.variantKey);
    const query = `variantKey=${encodeURIComponent(o.variantKey)}`;
    const entry = outputEntryByKey.get(o.variantKey);
    const variant = getVariant(o.variantKey);
    const isInfoArea = variant?.isInfoArea ?? false;
    // Effective printed dims — the info-area size override when applicable,
    // else the output's own dims (or the variant default for the fallback).
    const dims = entry
      ? effectiveOutputDims(entry, isInfoArea, infoAreaSizeMap)
      : { widthMm: variant?.defaultWidthMm ?? 100, heightMm: variant?.defaultHeightMm ?? 100 };
    const infoAreaSizeId = entry?.infoAreaSizeId ?? null;
    const pins = Object.entries(parseFieldOverrides(entry?.fieldOverrides)).map(
      ([field, value]) => ({
        label: PINNABLE_FIELD_LABELS[field as PinnableField],
        value: value as string,
      }),
    );
    return {
      styleId: style.id,
      // Gates the per-output Run + carton-print buttons inside the card.
      isAdmin,
      variantKey: o.variantKey,
      name: o.name,
      ready: o.ready,
      missing: o.missing.map((m) => m.label),
      excluded: o.excluded ?? false,
      exclusionReason: o.exclusionReason ?? null,
      widthMm: dims.widthMm,
      heightMm: dims.heightMm,
      pins,
      notes: outputDataNotes(o.variantKey, effItem, reqMapping),
      thumbSrc: asset
        ? `/api/admin/jobs/${asset.jobId}/thumbnail?${query}&v=${asset.id}.${asset.updatedAt.getTime()}`
        : null,
      pdfHref: asset
        ? `/api/admin/jobs/${asset.jobId}/preview?${query}#zoom=fit&toolbar=0&navpanes=0`
        : null,
      generatedAt: asset ? formatDate(asset.createdAt) : null,
      cartonNumbering: variant?.cartonNumbering ?? false,
      // Per-PDF review state for the latest generated asset (drives the
      // Approved/Rejected/In-review badge on the output row).
      reviewStatus: asset?.reviewStatus ?? null,
      multipleStyles: variant?.multipleStyles ?? false,
      isInfoArea,
      prodSpecId: style.prodSpec?.id ?? null,
      infoAreaSizeId,
      infoAreaSizeName: isInfoArea && infoAreaSizeId ? (infoAreaSizeMap.get(infoAreaSizeId)?.name ?? null) : null,
      infoAreaSizes: isInfoArea ? infoAreaSizeOptions : [],
    };
  });

  const readiness = computeReadiness({
    completionPct: style.completionPct,
    prodSpec: style.prodSpec
      ? {
          autoGenerateThresholdPct: style.prodSpec.autoGenerateThresholdPct,
          active: style.prodSpec.active,
        }
      : null,
    autoGenerateEnabled,
    missingDetailFields: missingDetail.map((m) => m.label),
    outputs: {
      total: outputReadiness.length,
      ready: outputReadiness.filter((o) => o.ready).length,
      blocking: outputReadiness
        .filter((o) => !o.ready)
        .map((o) => ({ name: o.name, missing: o.missing.map((m) => m.label) })),
    },
  });

  // Same computed status as the /styles list (effective-status.ts) so the
  // two can never disagree. PDFs gate the review states: jobs window first,
  // recentAssets as the fallback for assets older than the 10-job window.
  const statusView = computeEffectiveStatus({
    readiness,
    hasPdfs:
      style.jobs.some((j) => j.status !== "FAILED" && j.assets.length > 0) ||
      recentAssets.length > 0,
    latestJobStatus: latestJob?.status ?? null,
    outputs: {
      ready: outputReadiness.filter((o) => o.ready).length,
      total: outputReadiness.length,
    },
  });

  // Full pipeline diagnostic (SharePoint → PO → EANs → fields → generation →
  // review) as ONE role-aware notice — complements the job-status/rerun
  // controls in the header. This is the LIGHT case: it reuses outputReadiness
  // and the already-computed hasPdfs / latest job signals.
  const readinessNoticeHasPdfs =
    style.jobs.some((j) => j.status !== "FAILED" && j.assets.length > 0) ||
    recentAssets.length > 0;
  const readinessNotice = styleReadinessNotice(
    {
      eanStatus: style.eanStatus,
      eanAttempts: style.eanAttempts,
      poNumber: style.poNumber,
      poFileName: style.poFileName,
      hasProdSpec: Boolean(style.prodSpec),
      prodSpecHasOutputs: enabledOutputs.length > 0,
      outputReadiness,
      hasPdfs: readinessNoticeHasPdfs,
      latestJobStatus: latestJob?.status ?? null,
    },
    isAdmin ? "ADMIN" : "REVIEWER",
  );
  const mondayHref = mondayItemUrl(style.mondayBoardId, style.mondayItemId);
  const readinessHrefs: ReadinessHrefs = {
    openPoEans: "/po-eans",
    review: `/styles/${style.id}/review`,
    ...(mondayHref ? { openMonday: mondayHref } : {}),
    ...(style.prodSpec
      ? {
          openProdSpec: `/prod-specs/${style.prodSpec.id}`,
          setBusinessArea: `/prod-specs/${style.prodSpec.id}`,
          pinFieldInSpec: `/prod-specs/${style.prodSpec.id}`,
        }
      : {}),
    ...(style.supplier?.sharepointUrl
      ? { openSuppliersDrive: style.supplier.sharepointUrl }
      : {}),
  };

  // Read-only resolved spec fields for the Details tab — same resolution
  // the editor uses, so reviewers can verify what will render without
  // opening Edit.
  const resolvedFields = resolveStyleSpecFields(style);

  // Linked records + source identity — the relation-backed and meta fields
  // that the column-mapping "Resolved fields" list can't show (it only knows
  // mapped columns). Surfaced so a reviewer can verify the whole record,
  // e.g. WHICH supplier is linked (drives country of origin) — previously
  // invisible here despite the "Has supplier" filter on the list.
  const recordFields: Array<{ label: string; value: string | null; href?: string }> = [
    { label: "Customer", value: style.customer.name, href: `/customers/${style.customerId}` },
    {
      label: "Supplier",
      value: style.supplier
        ? `${style.supplier.name}${style.supplier.country ? ` · ${style.supplier.country}` : ""}`
        : null,
    },
    { label: "Business area", value: style.businessAreaRef?.name ?? style.businessArea ?? null },
    {
      label: "Prod spec",
      value: style.prodSpec?.name ?? null,
      href: style.prodSpec ? `/prod-specs/${style.prodSpec.id}` : undefined,
    },
    { label: "QR image", value: style.qrImage?.name ?? null },
    { label: "Monday item id", value: style.mondayItemId },
    { label: "Monday board id", value: style.mondayBoardId },
    { label: "Group", value: style.groupTitle },
    { label: "PO number", value: style.poNumber },
    { label: "Carton EAN", value: style.cartonEan },
    {
      label: "SharePoint folder",
      value: style.styleFolderUrl ? "Open ↗" : null,
      href: style.styleFolderUrl ?? undefined,
    },
    { label: "Created", value: formatDate(style.createdAt) },
    { label: "Updated", value: formatDate(style.updatedAt) },
  ];

  // Persisted PO → EAN resolution (per-size rows + carton), shown on the
  // Details tab with a Resolve / Re-resolve action.
  const eanView: EanView = {
    status: style.eanStatus,
    poFileName: style.poFileName,
    cartonEan: style.cartonEan,
    sizeEans: style.eans.map(toEanSize),
    useStyleBoardColour,
    // The last scrape's section dump, so the "what did this PO contain / why
    // these sizes" panel renders on LOAD. It used to appear only after a
    // Re-resolve (the dump lived in live diagnostics and nowhere else), which
    // meant re-scraping SharePoint to see an answer we already had. Rows
    // scraped before the column existed carry no timestamp of their own, so
    // eanResolvedAt backs the "scraped at" line. Never throws — a legacy or
    // hand-edited value just renders as "no snapshot".
    scrapeSnapshot: parsePoScrapeSnapshot(style.poScrapeSnapshot, style.eanResolvedAt),
  };

  // One serialised job list feeds BOTH tabs: the Prod Spec tab renders it
  // as the runs table (counts + owner only), the Review tab renders the
  // documents themselves. claimedBy* = the review owner ("Start review" /
  // first decision) so the team can follow along.
  const reviewJobs = style.jobs.map((j) => ({
    id: j.id,
    status: j.status,
    triggerSource: j.triggerSource,
    createdAt: j.createdAt.toISOString(),
    claimedByName: j.reviewClaimedBy ? j.reviewClaimedBy.name || j.reviewClaimedBy.email : null,
    claimedAtLabel: j.reviewClaimedAt ? formatDate(j.reviewClaimedAt) : null,
    assets: j.assets.map((a) => {
      // Carton-capable outputs get an in-tab "Customize" action (same as the
      // /review decide page). Capability + print dims come from the layout
      // variant; the registry is already loaded above (ensureLayoutVariantsLoaded).
      const baseKey = (a.variantKey ?? "").split("#")[0];
      const variant = baseKey ? getVariant(baseKey) : undefined;
      const carton =
        variant && (variant.cartonNumbering || variant.multipleStyles)
          ? {
              variantKey: baseKey,
              widthMm: variant.defaultWidthMm,
              heightMm: variant.defaultHeightMm,
              cartonNumbering: variant.cartonNumbering ?? false,
              multipleStyles: variant.multipleStyles ?? false,
            }
          : null;
      return {
        id: a.id,
        docType: a.docType,
        variantKey: a.variantKey,
        displayName: a.displayName,
        fileName: a.fileName,
        reviewStatus: a.reviewStatus,
        rejectReason: a.rejectReason,
        reviewedAt: a.reviewedAt?.toISOString() ?? null,
        reviewerEmail: a.reviewedBy?.email ?? null,
        carton,
      };
    }),
  }));

  // The Review tab's main grid shows the STYLE's CURRENT outputs — the latest
  // asset per (variantKey) across ALL non-FAILED jobs — not just the newest
  // job's files. Durable approval keeps an approved output in the job that
  // produced it, and per-output reruns spawn new jobs, so a fully-approved
  // style's approved layouts scatter across several jobs; keying off "the
  // latest job" hides everything not touched by the most recent run. This is
  // the SAME set /review decides on (getCurrentOutputsForStyle, loaded in the
  // first wave), so the tab and the review screen can never disagree about
  // what's approved.
  //
  // reviewedBy email is cosmetic ("by X · <date>"); resolve it from the jobs
  // window we already loaded. An approved asset older than that window keeps
  // its date (from the current output) but shows no email — acceptable.
  const reviewerEmailByAsset = new Map<string, string | null>();
  for (const j of style.jobs) {
    for (const a of j.assets) reviewerEmailByAsset.set(a.id, a.reviewedBy?.email ?? null);
  }
  const currentFiles = currentOutputs
    // Only generated documents (an asset exists and carries a decision). Still-
    // coming / excluded outputs have no file to show here.
    .filter((o) => o.jobAssetId != null && o.jobId != null && o.reviewStatus != null)
    .map((o) => {
      const baseKey = (o.variantKey ?? "").split("#")[0];
      const variant = baseKey ? getVariant(baseKey) : undefined;
      const carton =
        variant && (variant.cartonNumbering || variant.multipleStyles)
          ? {
              variantKey: baseKey,
              widthMm: variant.defaultWidthMm,
              heightMm: variant.defaultHeightMm,
              cartonNumbering: variant.cartonNumbering ?? false,
              multipleStyles: variant.multipleStyles ?? false,
            }
          : null;
      return {
        jobId: o.jobId as string,
        asset: {
          id: o.jobAssetId as string,
          docType: o.docType,
          variantKey: o.variantKey,
          displayName: o.name,
          fileName: o.fileName ?? (o.jobAssetId as string),
          reviewStatus: o.reviewStatus as "PENDING_REVIEW" | "APPROVED" | "REJECTED",
          rejectReason: o.rejectReason,
          reviewedAt: o.reviewedAt?.toISOString() ?? null,
          reviewerEmail: reviewerEmailByAsset.get(o.jobAssetId as string) ?? null,
          carton,
        },
      };
    });

  // ── What the page shows ─────────────────────────────────────────────────
  // Outputs waiting for a decision — the count on the Review button and tab.
  const pendingCount = currentFiles.filter((f) => f.asset.reviewStatus === "PENDING_REVIEW").length;
  const rollup = rollupOutputSlots(currentOutputs);
  const typeLabel = (docType: string) => docTypeLabel(docType, exclusionLabels);
  const businessAreaName = style.businessAreaRef?.name ?? style.businessArea ?? null;
  const meta = [style.customer.name, businessAreaName, style.poNumber ? `PO ${style.poNumber}` : null, style.supplier?.name ?? null]
    .filter(Boolean)
    .join(" · ");

  // Open comment threads per output (the newest per key wins).
  const ticketByKey = new Map<string, { status: "OPEN" | "IN_PROGRESS" | "FIXED"; comments: number }>();
  for (const t of openTickets) {
    if (!t.variantKey || ticketByKey.has(t.variantKey)) continue;
    ticketByKey.set(t.variantKey, {
      status: t.status as "OPEN" | "IN_PROGRESS" | "FIXED",
      comments: splitTicketComment(t.comment).length,
    });
  }
  const ticketFor = (variantKey: string) =>
    ticketByKey.get(variantKey) ?? ticketByKey.get(variantKey.split("#")[0]) ?? null;

  // Where each output stands toward the supplier's folder (queue rows are per output).
  const queueByKey = new Map(sendQueueRows.map((r) => [r.variantKey, r.sharePointStatus]));
  const queueStatusFor = (variantKey: string) =>
    queueByKey.get(variantKey) ?? queueByKey.get(variantKey.split("#")[0]) ?? null;

  const latestGeneratedAt = currentOutputs.reduce<Date | null>(
    (latest, o) => (o.generatedAt && (!latest || o.generatedAt > latest) ? o.generatedAt : latest),
    null,
  );
  const claimed = reviewJobs.find((j) => j.status === "AWAITING_REVIEW" && j.claimedByName);

  // ── The pipeline strip ──
  const resolvedEans = ["RESOLVED", "RESOLVED_FROM_MONDAY"].includes(style.eanStatus);
  const steps: PipelineStep[] = [
    {
      key: "monday",
      label: "Monday",
      detail: style.lastSyncedAt ? `Synced ${timeAgo(style.lastSyncedAt)}` : "Not synced yet",
      state: style.lastSyncedAt ? "done" : "todo",
    },
    !style.poNumber
      ? { key: "po", label: "PO & barcodes", detail: "No PO number yet", state: "warn" }
      : resolvedEans
        ? { key: "po", label: "PO & barcodes", detail: `${style.eans.length} sizes · PO ${style.poNumber}`, state: "done" }
        : style.eanStatus === "PENDING" || style.eanStatus === "RESOLVING" || style.eanStatus === "NONE"
          ? { key: "po", label: "PO & barcodes", detail: "Waiting for the PO scrape", state: "current" }
          : {
              key: "po",
              label: "PO & barcodes",
              detail:
                style.eanStatus === "PO_NOT_FOUND"
                  ? "PO not found in SharePoint"
                  : style.eanStatus === "STYLE_NOT_IN_PO"
                    ? "Style not found in the PO"
                    : style.eanStatus === "PO_FOUND_NO_EANS"
                      ? "PO has no EANs"
                      : "Couldn't read the PO",
              state: "bad",
            },
    style.prodSpec
      ? {
          key: "spec",
          label: "Prod spec",
          detail: style.prodSpec.active ? style.prodSpec.name : `${style.prodSpec.name} · inactive`,
          state: style.prodSpec.active && enabledOutputs.length > 0 ? "done" : "warn",
        }
      : { key: "spec", label: "Prod spec", detail: "None resolved", state: "bad" },
    missingDetail.length === 0
      ? { key: "fields", label: "Fields", detail: requiredKeys.length > 0 ? "All filled" : "None needed", state: "done" }
      : {
          key: "fields",
          label: "Fields",
          detail: `${missingDetail.length} missing · ${missingDetail.map((m) => m.label).join(", ")}`,
          state: "warn",
        },
    rollup.generating > 0
      ? { key: "generated", label: "Generated", detail: "Generating…", state: "current" }
      : rollup.generated > 0
        ? {
            key: "generated",
            label: "Generated",
            detail: `${rollup.generated} output${rollup.generated === 1 ? "" : "s"}${latestGeneratedAt ? ` · ${shortDate(latestGeneratedAt)}` : ""}`,
            state: "done",
          }
        : { key: "generated", label: "Generated", detail: "Not yet", state: "todo" },
    rollup.generated === 0
      ? { key: "review", label: "Review", detail: "Not yet", state: "todo" }
      : pendingCount > 0
        ? { key: "review", label: "Review", detail: `${pendingCount} pending`, state: "current" }
        : rollup.rejected > 0
          ? { key: "review", label: "Review", detail: `${rollup.rejected} with changes requested`, state: "warn" }
          : { key: "review", label: "Review", detail: "All decided", state: "done" },
    customerConfig.skipSupplierDelivery
      ? { key: "folder", label: "Supplier folder", detail: "Customer delivers itself", state: "done" }
      : !supplierDelivery
        ? { key: "folder", label: "Supplier folder", detail: "Nothing approved yet", state: "todo" }
        : supplierDelivery.noFolder > 0
          ? { key: "folder", label: "Supplier folder", detail: "PO folder missing", state: "bad" }
          : supplierDelivery.ambiguous > 0
            ? { key: "folder", label: "Supplier folder", detail: "Several PO folders match", state: "bad" }
            : {
                key: "folder",
                label: "Supplier folder",
                detail: `${supplierDelivery.uploaded} of ${supplierDelivery.total} delivered`,
                state: supplierDelivery.uploaded === supplierDelivery.total ? "done" : "current",
              },
  ];

  const tabs: TabLink[] = TABS.map((t) => ({
    key: t.key,
    label: t.label,
    href: `/styles/${style.id}?tab=${t.key}`,
    count: t.key === "review" && pendingCount > 0 ? pendingCount : undefined,
  }));

  // ── Review tab: the gallery ──
  const outputByKey = new Map(currentOutputs.map((o) => [o.variantKey, o]));
  const gallery: GalleryItem[] = currentFiles.map((f) => {
    const key = f.asset.variantKey ?? f.asset.id;
    const o = outputByKey.get(key);
    const t = ticketFor(key);
    return {
      key,
      anchor: outputAnchor(key),
      thumbSrc: `/api/admin/jobs/${f.jobId}/thumbnail?variantKey=${encodeURIComponent(key)}&v=${f.asset.id}.${o?.assetVersion ?? 0}`,
      typeLabel: typeLabel(f.asset.docType),
      name: f.asset.displayName ?? typeLabel(f.asset.docType),
      fileName: f.asset.fileName,
      status: f.asset.reviewStatus,
      ticket: t?.status ?? null,
      blocked: (o?.placeholderCount ?? 0) > 0,
      reviewer: f.asset.reviewerEmail,
      dateLabel: f.asset.reviewedAt ? shortDate(new Date(f.asset.reviewedAt)) : o?.generatedAt ? `generated ${shortDate(o.generatedAt)}` : null,
      comments: t?.comments ?? 0,
    };
  });
  const gallerySummary = [
    "The latest document per output, across all runs",
    rollup.approved > 0 ? `${rollup.approved} approved` : null,
    rollup.rejected > 0 ? `${rollup.rejected} with changes requested` : null,
    pendingCount > 0 ? `${pendingCount} pending` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="pb-10">
      <LogStyleView styleId={id} surface="STYLE" />
      <div className="px-6 pt-4">
        <div data-section="Page header" className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-[1_1_20rem] items-baseline gap-2">
            {/* Back to the list the reviewer came from — their PO search +
                filters, or this style's own PO. See back-to-styles.tsx. */}
            <BackToStyles poNumber={style.poNumber} variant="crumb" />
            <span aria-hidden="true" className="text-faint">
              /
            </span>
            <h1 className="text-ink truncate text-[18px] font-semibold tracking-[-0.01em]">{style.name}</h1>
            <span className="text-muted hidden min-w-0 truncate text-[13px] md:inline" title={meta}>
              {meta}
            </span>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {isAdmin && (
              <Link href={`/styles/${style.id}/edit`} className={buttonClass("secondary")}>
                <Pencil size={13} aria-hidden="true" />
                Edit
              </Link>
            )}
            {canRun && (
              <RerunButton
                styleId={style.id}
                disabled={latestJob?.status === "RUNNING" || latestJob?.status === "QUEUED"}
                label={currentFiles.length > 0 ? "Re-run" : "Generate"}
                pendingLabel={currentFiles.length > 0 ? "Re-running…" : "Generating…"}
              />
            )}
            {currentFiles.length > 0 && (
              <Link href={`/styles/${style.id}/review`} className={buttonClass(pendingCount > 0 ? "primary" : "secondary")}>
                Review
                {pendingCount > 0 ? <span className="tabular-nums opacity-70">{pendingCount}</span> : null}
              </Link>
            )}
          </div>
        </div>
        <p className="text-muted mt-0.5 text-[13px] md:hidden">{meta}</p>
      </div>

      <TabLinks items={tabs} active={tab} label="Style" className="mt-2 px-6" />

      <div className="flex flex-col gap-4 px-6 pt-4">
        {/* Orientation before diagnosis: Monday duplicates a style row per PO
            under the same name, so the first question is "am I on the right
            row?". Renders nothing when this style has no lookalikes. */}
        {relatedRows && <RelatedRowsCard {...relatedRows} className="" />}

        <PipelineStrip steps={steps}>
          <OutputReadinessNotice notice={readinessNotice} role={isAdmin ? "ADMIN" : "REVIEWER"} hrefs={readinessHrefs} />
        </PipelineStrip>

        {customerConfig.skipSupplierDelivery && <SkipSupplierDeliveryBadge />}

        {tab === "details" && (
          <DetailsTab
            style={style}
            missing={missing}
            resolvedFields={resolvedFields}
            recordFields={recordFields}
            readiness={readiness}
            statusView={statusView}
            eanView={eanView}
            requiredFieldKeys={requiredKeys}
            requiredFields={prodSpecReadiness}
            outputCards={outputCards}
            careDerived={careDerived}
            rollup={rollup}
            pendingCount={pendingCount}
            outputRows={currentOutputs.map((o) => {
              const t = ticketFor(o.variantKey);
              return {
                key: o.variantKey,
                name: o.name,
                fileName: o.fileName,
                typeLabel: typeLabel(o.docType),
                state: o.state,
                ignored: o.ignored,
                missing: o.missing.map((m) => m.label),
                exclusionReason: o.exclusionReason,
                ticket: t?.status ?? null,
                lastRun: o.generatedAt ? shortDate(o.generatedAt) : null,
                href: o.jobAssetId ? `/styles/${style.id}/review#${outputAnchor(o.variantKey)}` : null,
              };
            })}
            folder={{
              supplierName: style.supplier?.name ?? null,
              path: [
                style.supplier?.name ?? "No supplier",
                style.poNumber ? `${style.poNumber} - ${style.customer.name} - ${style.supplier?.name ?? "?"}` : "No PO",
                "APPROVED LAYOUTS",
              ].join(" / "),
              delivered: supplierDelivery ? { uploaded: supplierDelivery.uploaded, total: supplierDelivery.total } : null,
              openHref: supplierDelivery?.folderUrl ?? style.supplier?.sharepointUrl ?? null,
              ready: Boolean(style.supplier && style.supplier.sharepointUrl),
              problem: Boolean(supplierDelivery && (supplierDelivery.noFolder > 0 || supplierDelivery.ambiguous > 0)),
              files: currentOutputs
                .filter((o) => o.jobAssetId != null)
                .map((o) => ({
                  key: o.variantKey,
                  fileName: o.fileName ?? o.name,
                  state: folderFileState(o.reviewStatus, queueStatusFor(o.variantKey)),
                })),
            }}
            folderRoute={
              <SupplierFolderStatus
                styleId={style.id}
                supplierName={style.supplier?.name ?? null}
                folderUrl={style.supplier?.sharepointUrl ?? null}
                poNumber={style.poNumber}
                delivery={supplierDelivery}
                canFixTemplate={isAdmin}
                className=""
                showHeader={false}
              />
            }
            folderCheck={<FolderReconcilePanel styleId={style.id} poNumber={style.poNumber} className="" />}
            lastSyncedLabel={style.lastSyncedAt ? timeAgo(style.lastSyncedAt) : "never"}
          />
        )}

        {tab === "prod-spec" && (
          <ProdSpecTab
            styleId={style.id}
            prodSpec={style.prodSpec}
            customerId={style.customerId}
            customerName={style.customer.name}
            businessAreaId={style.businessAreaId}
            businessAreaLabel={businessAreaName}
            businessAreaText={style.businessArea ?? null}
            candidateBusinessArea={candidateBusinessArea}
            supplier={style.supplier}
            poNumber={style.poNumber}
            styleStatus={style.status}
            enabledOutputCount={enabledOutputs.length}
            requiredReadiness={prodSpecReadiness}
            outputsFilesPreview={outputsFilesPreview}
            supplierShare={
              supplierShare
                ? {
                    url: shareUrl(supplierShare.token),
                    pin: supplierShare.pin,
                    email: supplierShare.email,
                    visitCount: supplierShare.visitCount,
                    firstVisitedAt: supplierShare.firstVisitedAt?.toISOString() ?? null,
                    lastVisitedAt: supplierShare.lastVisitedAt?.toISOString() ?? null,
                  }
                : null
            }
            jobs={reviewJobs}
          />
        )}

        {tab === "review" && (
          <ReviewTab
            styleId={style.id}
            gallery={gallery}
            owner={claimed ? { name: claimed.claimedByName as string, since: claimed.claimedAtLabel } : null}
            summary={gallerySummary}
            jobs={reviewJobs}
          />
        )}
        {tab === "history" && <HistoryTab styleId={style.id} filter={historyFilter} />}
      </div>
    </div>
  );
}

// "24 Oct 14:02" — compact dates for tables and the pipeline.
const SHORT_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function shortDate(d: Date): string {
  return SHORT_DATE.format(d);
}

// A file's place on the way to the supplier's folder, for the folder card.
type FolderFileState = "in-folder" | "queued" | "failed" | "no-folder" | "waiting" | "rejected";
function folderFileState(
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED" | null,
  queueStatus: string | null,
): FolderFileState {
  if (queueStatus === "UPLOADED") return "in-folder";
  if (reviewStatus === "REJECTED") return "rejected";
  if (reviewStatus !== "APPROVED") return "waiting";
  if (queueStatus === "FAILED") return "failed";
  if (queueStatus === "NO_FOLDER" || queueStatus === "AMBIGUOUS") return "no-folder";
  return "queued";
}

const FOLDER_FILE: Record<FolderFileState, { label: string; tone: PillTone; icon: "check" | "x" | "dot" | "warn" }> = {
  "in-folder": { label: "In folder", tone: "good", icon: "check" },
  queued: { label: "Approved, queued", tone: "accent", icon: "dot" },
  failed: { label: "Upload failed", tone: "bad", icon: "x" },
  "no-folder": { label: "No PO folder", tone: "bad", icon: "warn" },
  waiting: { label: "Waits for approval", tone: "neutral", icon: "dot" },
  rejected: { label: "Changes requested", tone: "bad", icon: "x" },
};

// One output's state in the Outputs table — the decision, plus what's open on it.
type OutputRow = {
  key: string;
  name: string;
  fileName: string | null;
  typeLabel: string;
  state: string;
  ignored: boolean;
  missing: string[];
  exclusionReason: string | null;
  ticket: "OPEN" | "IN_PROGRESS" | "FIXED" | null;
  lastRun: string | null;
  href: string | null;
};

function OutputStatePills({ row }: { row: OutputRow }) {
  const main: { tone: PillTone; label: string } =
    row.state === "APPROVED"
      ? { tone: "good", label: "Approved" }
      : row.state === "REJECTED"
        ? { tone: "bad", label: "Changes requested" }
        : row.state === "BLOCKED"
          ? { tone: "warn", label: "Blocked" }
          : row.state === "TO_REVIEW"
            ? { tone: "neutral", label: "Pending" }
            : row.state === "AWAITING_DATA"
              ? { tone: "warn", label: "Missing data" }
              : row.state === "GENERATING"
                ? { tone: "accent", label: "Generating" }
                : row.state === "READY_TO_GENERATE"
                  ? { tone: "neutral", label: "Queued" }
                  : { tone: "neutral", label: row.ignored ? "Ignored" : "Excluded" };
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Pill tone={main.tone} dot>
        {main.label}
      </Pill>
      {row.ticket === "FIXED" ? (
        <Pill tone="good">Fixed, re-review</Pill>
      ) : row.ticket ? (
        <Pill tone="warn">{row.ticket === "IN_PROGRESS" ? "Being fixed" : "Open"}</Pill>
      ) : null}
    </span>
  );
}

function DetailsTab({
  style,
  missing,
  resolvedFields,
  recordFields,
  readiness,
  statusView,
  eanView,
  requiredFieldKeys,
  requiredFields,
  outputCards,
  careDerived,
  rollup,
  pendingCount,
  outputRows,
  folder,
  folderRoute,
  folderCheck,
  lastSyncedLabel,
}: {
  // useStyleBoardColour is omitted from the page query (guarded read instead —
  // see the findUnique above), so drop it from the prop type to match.
  style: Omit<NonNullable<Awaited<ReturnType<typeof db.style.findUnique>>>, "useStyleBoardColour"> & {
    jobs: Array<{
      id: string;
      status: string;
      triggerSource: string;
      createdAt: Date;
      assets: Array<unknown>;
      reviewActions: Array<{ user: { email: string } }>;
    }>;
    prodSpec: { name: string } | null;
  };
  missing: Array<{ id: string; label: string }>;
  resolvedFields: ResolvedSpecField[];
  recordFields: Array<{ label: string; value: string | null; href?: string }>;
  readiness: Readiness;
  statusView: EffectiveStatus;
  eanView: EanView;
  requiredFieldKeys: readonly string[];
  requiredFields: { filled: number; total: number; fields: Array<{ label: string; ok: boolean }> };
  outputCards: StyleOutputCardProps[];
  careDerived: {
    symbols: Array<{ name: string; resolved: boolean; token: string }>;
    lines: Array<{ text: string; visible: boolean; reason: string }>;
  };
  rollup: ReturnType<typeof rollupOutputSlots>;
  pendingCount: number;
  outputRows: OutputRow[];
  folder: {
    supplierName: string | null;
    path: string;
    delivered: { uploaded: number; total: number } | null;
    openHref: string | null;
    ready: boolean;
    problem: boolean;
    files: Array<{ key: string; fileName: string; state: FolderFileState }>;
  };
  folderRoute: ReactNode;
  folderCheck: ReactNode;
  lastSyncedLabel: string;
}) {
  const requiredSet = new Set(requiredFieldKeys);
  // Colour per resolved EAN (read off the PO variant label) so the per-size
  // EAN-13 lines under Resolved fields can name the colourway — duplicate
  // sizes on multi-colour POs are ambiguous without it. Keyed by EAN because
  // the rendered value is the size=ean map string, which drops the colour.
  const eanColor = new Map<string, string>();
  for (const e of eanView.sizeEans) {
    const color = colorFromVariantLabel(e.variantLabel);
    if (e.ean13 && color) eanColor.set(e.ean13, color);
  }
  // Output fields the enabled outputs need but that are empty — the real
  // "can it generate" gate, distinct from the required-columns completion %.
  const missingOutput = requiredFields.fields.filter((f) => !f.ok).map((f) => f.label);
  const heldBack = outputCards.filter((o) => !o.ready && !o.excluded).length;
  // Deduped fields blocking any not-ready (non-excluded) output — surfaced in
  // the collapsed accordion header so blockers are visible without expanding.
  const blockingFieldLabels = Array.from(
    new Set(outputCards.filter((o) => !o.ready && !o.excluded).flatMap((o) => o.missing)),
  );
  const notGenerated = outputRows.filter((r) => r.state === "AWAITING_DATA").length;
  const pending = rollup.toReview + rollup.blocked;
  const notYet = Math.max(0, rollup.total - rollup.approved - rollup.rejected - pending);

  const fieldRows: ResolvedFieldRow[] = resolvedFields.map((f) => {
    const isRequired = requiredSet.has(f.field);
    const isMissing = isRequired && !f.value.trim();
    return {
      key: f.field,
      label: f.label,
      text: f.value,
      required: isRequired,
      missing: isMissing,
      value: (
        <>
          {f.field === "ean13" && f.value.includes("=") ? (
            // Per-size EAN map ("S=570…,M=570…") — one line per size instead
            // of an unreadable comma run, with the colourway when known.
            <div className="space-y-0.5 font-mono text-[12px]">
              {f.value.split(",").map((pair, j) => {
                const [size, ean] = pair.split("=");
                const color = eanColor.get(ean?.trim() ?? "");
                return (
                  <div key={`${pair}-${j}`}>
                    <span className="text-muted inline-block w-12">{size?.trim()}</span>
                    <span>{ean?.trim()}</span>
                    {color && <span className="text-faint ml-2">{color}</span>}
                  </div>
                );
              })}
            </div>
          ) : (
            f.value || (isMissing ? "Missing" : "—")
          )}
          {f.fallback && (
            <Pill tone="accent" className="ml-1.5 align-middle" title={`No mapped value — falling back to the ${f.fallback}`}>
              via {f.fallback}
            </Pill>
          )}
        </>
      ),
    };
  });

  return (
    <div className="flex flex-col gap-4">
      <section className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {/* Required COLUMNS: progress toward the auto-generate threshold
            (measured against the customer's required columns). */}
        <div className="border-line bg-surface rounded-xl border px-4 py-3">
          <div className="text-ink text-[13px] font-medium">Required columns</div>
          <div className="text-ink mt-1 text-[24px] leading-8 font-semibold tabular-nums">{style.completionPct}%</div>
          <div className="text-muted text-[12px]">
            {missing.length > 0 ? `${missing.length} missing` : "All filled"} · auto-runs at {readiness.threshold}%
          </div>
          <div className="bg-subtle relative mt-3 h-1.5 rounded-full" title={missing.map((m) => m.label).join(", ") || undefined}>
            <div
              className={`h-full rounded-full ${readiness.hasProdSpec && readiness.meetsThreshold ? "bg-accent" : "bg-warn"}`}
              style={{ width: `${style.completionPct}%` }}
            />
            {readiness.hasProdSpec && readiness.threshold < 100 ? (
              <span
                className="bg-ink absolute -top-1 h-3.5 w-0.5 rounded-full"
                style={{ left: `${readiness.threshold}%` }}
                title={`Auto-runs at ${readiness.threshold}%`}
              />
            ) : null}
          </div>
        </div>

        {/* Required OUTPUT FIELDS: what the enabled outputs need to render —
            the real "can it generate" gate. */}
        <div className="border-line bg-surface rounded-xl border px-4 py-3">
          <div className="text-ink text-[13px] font-medium">Output fields</div>
          <div className="text-ink mt-1 text-[24px] leading-8 font-semibold tabular-nums">
            {requiredFields.total > 0 ? `${requiredFields.filled}/${requiredFields.total}` : "—"}
          </div>
          <div className={`text-[12px] ${missingOutput.length > 0 ? "text-warn" : "text-muted"}`}>
            {requiredFields.total === 0
              ? "This style's outputs need no detail fields."
              : missingOutput.length > 0
                ? `${missingOutput.join(", ")} ${missingOutput.length === 1 ? "is" : "are"} missing and hold${missingOutput.length === 1 ? "s" : ""} back ${heldBack} output${heldBack === 1 ? "" : "s"}`
                : "Every field the outputs need is there."}
          </div>
        </div>

        {/* Outputs approved, as one bar: approved / changes requested / pending / not generated. */}
        <div className="border-line bg-surface rounded-xl border px-4 py-3">
          <div className="text-ink text-[13px] font-medium">Outputs approved</div>
          <div className="text-ink mt-1 text-[24px] leading-8 font-semibold tabular-nums">
            {rollup.approved}/{rollup.total}
          </div>
          <div className="bg-subtle mt-2 flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
            {rollup.approved > 0 ? <span className="bg-good" style={{ flex: rollup.approved }} /> : null}
            {rollup.rejected > 0 ? <span className="bg-bad" style={{ flex: rollup.rejected }} /> : null}
            {pending > 0 ? <span className="bg-faint" style={{ flex: pending }} /> : null}
            {notYet > 0 ? <span style={{ flex: notYet }} /> : null}
          </div>
          <div className="text-muted mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px]">
            <span className="inline-flex items-center gap-1">
              <StatusDot tone="good" className="size-1.5 rounded-sm" /> Approved {rollup.approved}
            </span>
            <span className="inline-flex items-center gap-1">
              <StatusDot tone="bad" className="size-1.5 rounded-sm" /> Rejected {rollup.rejected}
            </span>
            <span className="inline-flex items-center gap-1">
              <StatusDot tone="neutral" className="size-1.5 rounded-sm" /> Pending {pending}
            </span>
          </div>
        </div>

        {/* Workflow status — the same computed pill as the /styles list
            (effective-status.ts) so the two never disagree. */}
        <div className="border-line bg-surface rounded-xl border px-4 py-3">
          <div className="text-ink text-[13px] font-medium">Status</div>
          <div className="mt-2">
            <Pill tone={STATUS_TONE[statusView.tone]}>{statusView.label}</Pill>
          </div>
          <div className="text-muted mt-2 text-[12px]">{pendingCount > 0 ? `${pendingCount} output${pendingCount === 1 ? "" : "s"} wait for a decision` : statusView.hint}</div>
          <div className="text-muted text-[12px]">Last synced from Monday {lastSyncedLabel}</div>
        </div>
      </section>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-4">
          {/* Every declared output: what it is, where it stands, when it last ran. */}
          <section data-section="Outputs" className="border-line bg-surface overflow-hidden rounded-xl border">
            <div className="border-line flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
              <div>
                <h2 className="text-ink text-[14px] font-semibold">Outputs</h2>
                <p className="text-muted text-[12px]">
                  {rollup.generated} generated{style.prodSpec ? ` from ${style.prodSpec.name}` : ""}
                  {notGenerated > 0 ? ` · ${notGenerated} can't generate yet` : ""}
                </p>
              </div>
              {rollup.generated > 0 ? (
                <Link href={`/styles/${style.id}/review`} className={buttonClass("secondary", "sm")}>
                  Open review
                </Link>
              ) : null}
            </div>
            {outputRows.length === 0 ? (
              <p className="text-muted px-4 py-8 text-center text-[13px]">This style&rsquo;s prod spec has no outputs yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-line text-muted border-b text-left text-[12px]">
                      <th className="px-4 py-2 font-medium">Output</th>
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 font-medium">State</th>
                      <th className="px-4 py-2 text-right font-medium">Last run</th>
                    </tr>
                  </thead>
                  <tbody className="divide-line divide-y">
                    {outputRows.map((r) => (
                      <tr key={r.key} className={r.href ? "hover:bg-subtle transition-colors duration-150" : ""}>
                        <td className="max-w-[22rem] px-4 py-2.5">
                          {r.href ? (
                            <Link href={r.href} className="text-ink block truncate font-medium hover:underline" title={r.name}>
                              {r.name}
                            </Link>
                          ) : (
                            <span className="text-ink block truncate font-medium" title={r.name}>
                              {r.name}
                            </span>
                          )}
                          <span className="text-muted block truncate font-mono text-[11px]" title={r.fileName ?? undefined}>
                            {r.state === "AWAITING_DATA" && r.missing.length > 0
                              ? `Needs ${r.missing.join(", ")}`
                              : r.state === "EXCLUDED" && r.exclusionReason
                                ? r.exclusionReason
                                : r.fileName ?? "—"}
                          </span>
                        </td>
                        <td className="text-muted px-3 py-2.5 whitespace-nowrap">{r.typeLabel}</td>
                        <td className="px-3 py-2.5">
                          <OutputStatePills row={r} />
                        </td>
                        <td className="text-muted px-4 py-2.5 text-right whitespace-nowrap tabular-nums">{r.lastRun ?? "Not generated"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {outputCards.length > 0 && (
            // The per-output tools: live preview, pins, Run, carton prints,
            // info-area size. Folded; each row's preview only loads when opened.
            <OutputsAccordion
              readyCount={outputCards.filter((o) => o.ready).length}
              total={outputCards.length}
              missingFieldLabels={blockingFieldLabels}
            >
              {outputCards.map((card) => (
                <StyleOutputCard key={card.variantKey} {...card} />
              ))}
            </OutputsAccordion>
          )}

          <ResolvedFieldsCard rows={fieldRows} description="What the PDFs print, resolved from the column mapping" />

          <section data-section="EAN barcodes" className="border-line bg-surface overflow-hidden rounded-xl border">
            <div className="border-line border-b px-4 py-3">
              <h2 className="text-ink text-[14px] font-semibold">EAN barcodes</h2>
              <p className="text-muted text-[12px]">
                Read from {eanView.poFileName ?? "the PO PDF"}, per size, in size order
              </p>
            </div>
            <div className="flex flex-col gap-3 p-4">
              {style.poNumber && <PoPreview styleId={style.id} poNumber={style.poNumber} status={style.eanStatus} />}
              <EanPanel styleId={style.id} hasPo={Boolean(style.poNumber)} initial={eanView} />
            </div>
          </section>

          {/* For the question the panels above didn't happen to answer — the
              one that would otherwise have become a Slack message. */}
          <AskStylePanel styleId={style.id} className="" />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {/* What the supplier has: each file's way into their folder. */}
          <section data-section="Supplier folder" className="border-line bg-surface overflow-hidden rounded-xl border">
            <div className="border-line border-b px-4 py-3">
              <h2 className="text-ink text-[14px] font-semibold">Supplier folder</h2>
              <p className="text-muted font-mono text-[11px] break-words" data-private>
                {folder.path}
              </p>
              <div className="mt-2">
                {folder.delivered ? (
                  <Pill tone={folder.delivered.uploaded === folder.delivered.total ? "good" : "neutral"}>
                    {folder.delivered.uploaded} of {folder.delivered.total} delivered
                  </Pill>
                ) : (
                  <Pill tone={folder.ready ? "neutral" : "warn"}>{folder.ready ? "Nothing approved yet" : "Delivery not set up"}</Pill>
                )}
              </div>
            </div>
            {folder.files.length > 0 ? (
              <ul className="divide-line divide-y">
                {folder.files.map((f) => {
                  const st = FOLDER_FILE[f.state];
                  return (
                    <li key={f.key} className="flex items-center gap-2 px-4 py-2">
                      <FolderIcon icon={st.icon} tone={st.tone} />
                      <span className="text-ink min-w-0 flex-1 truncate font-mono text-[12px]" title={f.fileName}>
                        {f.fileName}
                      </span>
                      <span className="text-muted shrink-0 text-[12px]">{st.label}</span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <div className="border-line flex flex-col gap-3 border-t px-4 py-3">
              {folderCheck}
              <div className="flex flex-wrap items-center gap-2">
                {folder.openHref ? (
                  <a href={folder.openHref} target="_blank" rel="noopener noreferrer" className={buttonClass("ghost", "sm")}>
                    Open in SharePoint
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                ) : null}
              </div>
              {/* How a push finds the folder: supplier on the Pre-Order board →
                  its folder link on the Suppliers board. Open when it's broken. */}
              <details className="group" {...(!folder.ready || folder.problem ? { open: true } : {})}>
                <summary className="text-muted hover:text-ink flex cursor-pointer list-none items-center gap-1 text-[12px] [&::-webkit-details-marker]:hidden">
                  <ChevronRight size={13} aria-hidden="true" className="transition-transform group-open:rotate-90" />
                  Delivery route
                </summary>
                <div className="mt-2">{folderRoute}</div>
              </details>
            </div>
          </section>

          <section data-section="Record and links" className="border-line bg-surface overflow-hidden rounded-xl border">
            <div className="border-line border-b px-4 py-3">
              <h2 className="text-ink text-[14px] font-semibold">Record &amp; links</h2>
              <p className="text-muted text-[12px]">The linked records and where this row comes from</p>
            </div>
            <dl className="divide-line divide-y text-[13px]">
              {recordFields.map((f) => {
                const external = f.href?.startsWith("http");
                return (
                  <div key={f.label} className="flex gap-3 px-4 py-2">
                    <dt className="text-muted w-32 shrink-0 text-[12px] leading-5">{f.label}</dt>
                    <dd className={`min-w-0 flex-1 break-words ${f.value ? "text-ink" : "text-faint"}`}>
                      {f.value ? (
                        f.href ? (
                          <a
                            href={f.href}
                            className="text-accent-text hover:underline"
                            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                          >
                            {f.value}
                          </a>
                        ) : (
                          f.value
                        )
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </section>

          {careDerived.lines.length > 0 && (
            <section data-section="Care instructions" className="border-line bg-surface overflow-hidden rounded-xl border">
              <div className="border-line border-b px-4 py-3">
                <h2 className="text-ink text-[14px] font-semibold">Care instructions</h2>
                <p className="text-muted text-[12px]">The care-label catalogue, filtered by this row&rsquo;s wash-care symbols</p>
              </div>
              <div className="px-4 py-3">
                <div className="flex flex-wrap gap-1.5">
                  {careDerived.symbols.length === 0 ? (
                    <span className="text-faint text-[12px]">No symbols on the row, so only &ldquo;always&rdquo; lines print</span>
                  ) : null}
                  {careDerived.symbols.map((s) => (
                    <Pill
                      key={s.token}
                      tone={s.resolved ? "neutral" : "warn"}
                      title={
                        s.resolved
                          ? s.name
                          : `Unknown token "${s.token}" — not in the symbol catalogue (no artwork, no care-line suppression). Map it at /settings/washcare-symbols.`
                      }
                    >
                      {s.resolved ? s.name : `Unknown ${s.name}`}
                    </Pill>
                  ))}
                </div>
                <ul className="mt-3 flex flex-col gap-1">
                  {careDerived.lines.map((line) => (
                    <li key={line.text} className="flex items-baseline gap-2 text-[12px]">
                      {line.visible ? (
                        <Check size={12} aria-hidden="true" className="text-good shrink-0 translate-y-0.5" />
                      ) : (
                        <X size={12} aria-hidden="true" className="text-faint shrink-0 translate-y-0.5" />
                      )}
                      <span className={line.visible ? "text-ink" : "text-faint"}>{line.text}</span>
                      <span className="text-faint ml-auto shrink-0 pl-2 text-right text-[11px]">{line.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section data-section="Runs" className="border-line bg-surface overflow-hidden rounded-xl border">
            <div className="border-line flex items-start justify-between gap-3 border-b px-4 py-3">
              <div>
                <h2 className="text-ink text-[14px] font-semibold">Runs</h2>
                <p className="text-muted text-[12px]">Every generation is kept</p>
              </div>
              <Link href={`/styles/${style.id}?tab=prod-spec`} className={buttonClass("ghost", "sm")}>
                All runs
              </Link>
            </div>
            {style.jobs.length === 0 ? (
              <p className="text-muted px-4 py-6 text-center text-[13px]">No runs yet.</p>
            ) : (
              <ul className="divide-line divide-y">
                {style.jobs.slice(0, 4).map((j) => (
                  <li key={j.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-ink truncate text-[13px] font-medium">{triggerLabel(j.triggerSource)}</div>
                      <div className="text-muted text-[12px]">
                        {shortDate(j.createdAt)} · {j.assets.length} file{j.assets.length === 1 ? "" : "s"}
                      </div>
                    </div>
                    <RunPill status={j.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function RunPill({ status }: { status: string }) {
  const tone: PillTone =
    status === "APPROVED"
      ? "good"
      : status === "REJECTED" || status === "FAILED"
        ? "bad"
        : status === "AWAITING_REVIEW"
          ? "accent"
          : status === "RUNNING" || status === "QUEUED"
            ? "accent"
            : "neutral";
  const label =
    status === "AWAITING_REVIEW" ? "Awaiting review" : status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
  return <Pill tone={tone}>{label}</Pill>;
}

function FolderIcon({ icon, tone }: { icon: "check" | "x" | "dot" | "warn"; tone: PillTone }) {
  const color = tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "accent" ? "text-accent-text" : "text-faint";
  if (icon === "check") return <CircleCheck size={14} aria-hidden="true" className={`shrink-0 ${color}`} />;
  if (icon === "x") return <CircleX size={14} aria-hidden="true" className={`shrink-0 ${color}`} />;
  if (icon === "warn") return <AlertTriangle size={14} aria-hidden="true" className={`shrink-0 ${color}`} />;
  return <CircleDashed size={14} aria-hidden="true" className={`shrink-0 ${color}`} />;
}
