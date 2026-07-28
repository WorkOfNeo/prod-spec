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
import { computeReadiness, type Readiness, type ReadinessTone } from "@/lib/styles/readiness";
import {
  computeEffectiveStatus,
  EFFECTIVE_STATUS_TONE_CLASSES,
  type EffectiveStatus,
} from "@/lib/styles/effective-status";
import { outputReadinessForStyle } from "@/lib/styles/output-readiness";
import { styleReadinessNotice } from "@/lib/styles/readiness-notice";
import { OutputReadinessNotice, type ReadinessHrefs } from "@/components/output-readiness-notice";
import { mondayItemUrl } from "@/lib/monday/url";
import { loadDocTypeExclusionRules, loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { loadIgnoredOutputKeys } from "@/lib/outputs/output-ignores";
import { getCurrentOutputsForStyle } from "@/lib/outputs/current-outputs";
import { RerunButton } from "./rerun-button";
import { StyleOutputCard, type StyleOutputCardProps } from "./style-output-card";
import { OutputsAccordion } from "./outputs-accordion";
import { ProdSpecTab } from "./prod-spec-tab";
import { ReviewTab } from "./review-tab";
import { HistoryTab } from "./history-tab";
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
import { RelatedRowsCardForStyle } from "./related-rows-card";
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

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const style = await db.style.findUnique({ where: { id }, select: { name: true } });
  return { title: style?.name ?? "Style" };
}

const READINESS_TONE: Record<ReadinessTone, { box: string; dot: string }> = {
  ready: { box: "border-emerald-200 bg-emerald-50 text-emerald-900", dot: "bg-emerald-500" },
  paused: { box: "border-blue-200 bg-blue-50 text-blue-900", dot: "bg-blue-500" },
  incomplete: { box: "border-amber-200 bg-amber-50 text-amber-900", dot: "bg-amber-500" },
  blocked: { box: "border-amber-200 bg-amber-50 text-amber-900", dot: "bg-amber-500" },
};

// Completion bar with a threshold marker. The fill turns green once the
// style clears its threshold; the tick shows where the threshold sits.
function CompletionBar({
  pct,
  threshold,
  ready,
}: {
  pct: number;
  threshold: number | null;
  ready: boolean;
}) {
  return (
    <div className="relative h-2 w-full overflow-hidden rounded-full bg-zinc-100">
      <div
        className={`h-full ${ready ? "bg-emerald-500" : "bg-zinc-900"}`}
        style={{ width: `${pct}%` }}
      />
      {threshold != null && threshold < 100 && (
        <div
          className="absolute top-0 h-full w-0.5 bg-zinc-500"
          style={{ left: `${threshold}%` }}
          title={`Threshold ${threshold}%`}
        />
      )}
    </div>
  );
}

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
  searchParams: Promise<{ tab?: string }>;
}) {
  // Output Builder layouts resolve as variants in the readiness walks below.
  await ensureLayoutVariantsLoaded();

  const { id } = await params;
  const tabParam = (await searchParams).tab;
  const tab: TabKey =
    tabParam === "prod-spec"
      ? "prod-spec"
      : tabParam === "review"
        ? "review"
        : tabParam === "history"
          ? "history"
          : "details";

  // The output cards' generation actions (per-output Run, carton prints) stay
  // ADMIN-only — the API enforces it, and REVIEWERs (who can reach this page)
  // must not see buttons that would only 403. The header Generate / Re-run is
  // the exception: a reviewer opening a style that hasn't generated yet has no
  // review screen to work from, so kicking off a whole-style (re)generation is
  // part of reviewing (canReview) — the rerun endpoint enforces the same.
  const { role } = await getSessionWithRole();
  const isAdmin = role === "ADMIN";
  const canRun = role === "ADMIN" || role === "REVIEWER";

  const style = await db.style.findUnique({
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
  });
  if (!style) notFound();

  // Latest generated asset per output variant — powers the realistic
  // thumbnail on each Outputs row. Queried directly instead of scanning
  // style.jobs: that window only holds the last 10 jobs, and per-output
  // reruns (one asset per job) push older outputs' assets out of it fast.
  // Metadata only — the PNG bytes come from the thumbnail endpoint.
  const recentAssets = await db.jobAsset.findMany({
    where: { job: { styleId: id }, variantKey: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, jobId: true, variantKey: true, createdAt: true, reviewStatus: true },
    take: 400,
  });
  const latestAssetByVariant = new Map<
    string,
    { id: string; jobId: string; createdAt: Date; reviewStatus: AssetReviewStatus }
  >();
  for (const a of recentAssets) {
    if (a.variantKey && !latestAssetByVariant.has(a.variantKey)) {
      latestAssetByVariant.set(a.variantKey, { id: a.id, jobId: a.jobId, createdAt: a.createdAt, reviewStatus: a.reviewStatus });
    }
    // Multi-document assets ("layout:<id>#<size>") also register under
    // their BASE key so the output card finds its latest asset.
    const base = a.variantKey?.split("#")[0];
    if (base && base !== a.variantKey && !latestAssetByVariant.has(base)) {
      latestAssetByVariant.set(base, { id: a.id, jobId: a.jobId, createdAt: a.createdAt, reviewStatus: a.reviewStatus });
    }
  }

  const latestJob = style.jobs[0];
  const missing = (style.missingFields as Array<{ id: string; label: string }>) ?? [];

  // The style's durable supplier share (if approved at least once) — drives
  // the "Supplier link" panel on the prod-spec tab: the stable link + PIN to
  // forward, and whether the supplier has opened it.
  const supplierShare = await db.supplierShare.findUnique({
    where: { styleId: id },
    select: {
      token: true,
      pin: true,
      email: true,
      visitCount: true,
      firstVisitedAt: true,
      lastVisitedAt: true,
    },
  });

  // This style's supplier-send queue rows — the ACTUAL SharePoint push outcome
  // for the "Supplier folder" panel (found + link / no PO folder / ambiguous).
  const sendQueueRows = await db.supplierSendQueueItem.findMany({
    where: { styleId: id },
    select: { sharePointStatus: true, sharePointFolderUrl: true, sharePointFolderMatches: true },
  });
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

  const autoGenerateEnabled = await getAutoGenerateEnabled();

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

  // Doc-type keyword exclusion rules + per-style operator ignores → mark
  // outputs skipped for this style (rule hit, or ignored from the review
  // surfaces), with a reason for the card.
  const [exclusionRules, exclusionLabels, ignoredOutputKeys] = await Promise.all([
    loadDocTypeExclusionRules(),
    loadDocTypeLabels(),
    loadIgnoredOutputKeys(id),
  ]);

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

  // Pre-run files preview for the Prod Spec popover: per enabled output,
  // the PDFs the NEXT run would emit (count + resolved names). Assembled
  // from the SAME StyleData builder, pins and naming rules the runner
  // uses — repeat/split-aware for Output Builder layouts — so the
  // operator can verify the split settings against this style's actual
  // size/EAN rows before generating anything. qrImage is deliberately
  // null: the page only selects its name (the image is heavy) and file
  // naming never reads it.
  const outputsFilesPreview: Array<{
    variantKey: string;
    name: string;
    known: boolean;
    files: string[];
  }> = await (async () => {
    if (!style.prodSpec || enabledOutputs.length === 0) return [];
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
  })();

  // Derived care instructions for THIS style — the standard catalogue
  // filtered by the row's wash-care symbols, with per-line verdicts. The
  // same pure rule the renderer applies; shown so the operator sees WHAT
  // will print and WHY a line is dropped, before generating anything.
  const careDerived = await (async () => {
    const symbolMap = await loadWashcareSymbols();
    const rawTokens = resolveMappedField(effItem, reqMapping, "washCare")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const tokens = rejoinWashTokens(rawTokens, symbolMap);
    const symbols = tokens.map((token) => {
      const resolved = getWashcareSymbol(symbolMap, token);
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
    const labels = await loadCareLabels();
    const lines = labels.map((label) => {
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

  // Info-area sizing catalogue: the active sizes the dropdown offers, plus a
  // full map (incl. inactive) to resolve a current pick's name + printed
  // dims. Resilient to a not-yet-deployed table (empty → custom only).
  const [infoAreaSizesActive, infoAreaSizeMap] = await Promise.all([
    listActiveInfoAreaSizes(),
    loadInfoAreaSizeMap(),
  ]);
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
        ? `/api/admin/jobs/${asset.jobId}/thumbnail?${query}&v=${asset.id}`
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
    useStyleBoardColour: await readUseStyleBoardColour(style.id),
    // The last scrape's section dump, so the "what did this PO contain / why
    // these sizes" panel renders on LOAD. It used to appear only after a
    // Re-resolve (the dump lived in live diagnostics and nowhere else), which
    // meant re-scraping SharePoint to see an answer we already had. Rows
    // scraped before the column existed carry no timestamp of their own, so
    // eanResolvedAt backs the "scraped at" line. Never throws — a legacy or
    // hand-edited value just renders as "no snapshot".
    scrapeSnapshot: parsePoScrapeSnapshot(style.poScrapeSnapshot, style.eanResolvedAt),
  };

  // If the FK is missing but we have business-area text, see if any
  // active BusinessArea row matches by mondayValue or name. The tab
  // shows a "Link to <BA>" one-click action when there's a match.
  const candidateBusinessArea = await (async () => {
    if (style.businessAreaId) return null;
    const text = (style.businessArea ?? "").trim();
    if (!text) return null;
    const lowered = text.toLowerCase();
    const rows = await db.businessArea.findMany({ where: { active: true } });
    const match =
      rows.find((b) => b.mondayValue.toLowerCase() === lowered) ??
      rows.find((b) => b.name.toLowerCase() === lowered);
    return match ? { id: match.id, name: match.name, mondayValue: match.mondayValue } : null;
  })();

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
  // the SAME set /review decides on (getCurrentOutputsForStyle), so the tab and
  // the review screen can never disagree about what's approved.
  const currentOutputs = await getCurrentOutputsForStyle(style.id);
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

  return (
    <div className="px-8 py-8">
      <LogStyleView styleId={id} surface="STYLE" />
      <Link href="/styles" className="text-xs text-zinc-500 underline">
        ← All styles
      </Link>
      <div className="mt-2 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{style.name}</h1>
          <p className="text-sm text-zinc-500">
            {style.customer.name} · {style.businessAreaRef?.name ?? style.businessArea ?? "—"} · Monday {style.mondayItemId}
            {style.poNumber ? ` · PO ${style.poNumber}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {latestJob?.status === "AWAITING_REVIEW" && (
            <Link
              href={`/styles/${style.id}/review`}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
            >
              Review
            </Link>
          )}
          {isAdmin && (
            <Link
              href={`/styles/${style.id}/edit`}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
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
        </div>
      </div>

      {/* Orientation before diagnosis: Monday duplicates a style row per PO
          under the same name, so the first question is "am I on the right
          row?", not "is this row ready?". Sits above the readiness notice
          because a correct answer to the wrong row is still the wrong answer.
          Renders nothing at all — no wrapper, no spacing — when this style has
          no lookalikes, which is the norm. */}
      <RelatedRowsCardForStyle styleId={style.id} />

      {/* Above the tabs, side by side: the pipeline readiness notice (a
          collapsible accordion) on the left, the Supplier folder / SharePoint
          delivery on the right — both stay visible on every tab. */}
      <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <OutputReadinessNotice
          notice={readinessNotice}
          role={isAdmin ? "ADMIN" : "REVIEWER"}
          hrefs={readinessHrefs}
          collapsible
        />
        <SupplierFolderStatus
          styleId={style.id}
          supplierName={style.supplier?.name ?? null}
          folderUrl={style.supplier?.sharepointUrl ?? null}
          poNumber={style.poNumber}
          delivery={supplierDelivery}
          className=""
        />
      </div>

      {/* Full width, not in the grid above: it lists filenames, which don't fit
          a half-width cell. Answers "did the files actually land, and is what's
          in the folder still what we think it is?" — the half the recurring
          verify sweep can't cover, since that only re-checks rows it already
          believes it uploaded. */}
      <FolderReconcilePanel styleId={style.id} className="mt-4" />

      {customerConfig.skipSupplierDelivery && <SkipSupplierDeliveryBadge className="mt-4" />}

      <nav className="mt-6 border-b border-zinc-200">
        <ul className="flex gap-1">
          {TABS.map((t) => (
            <li key={t.key}>
              <Link
                href={`/styles/${style.id}?tab=${t.key}`}
                scroll={false}
                className={`inline-block border-b-2 px-4 py-2 text-sm font-medium transition ${
                  tab === t.key
                    ? "border-zinc-900 text-zinc-900"
                    : "border-transparent text-zinc-500 hover:text-zinc-700"
                }`}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

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
        />
      )}

      {tab === "prod-spec" && (
        <ProdSpecTab
          styleId={style.id}
          prodSpec={style.prodSpec}
          customerId={style.customerId}
          businessAreaId={style.businessAreaId}
          businessAreaLabel={style.businessAreaRef?.name ?? style.businessArea ?? null}
          businessAreaText={style.businessArea ?? null}
          candidateBusinessArea={candidateBusinessArea}
          supplier={style.supplier}
          poNumber={style.poNumber}
          styleStatus={style.status}
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
        <ReviewTab styleId={style.id} current={currentFiles} jobs={reviewJobs} />
      )}
      {tab === "history" && <HistoryTab styleId={style.id} />}
    </div>
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
}) {
  const tone = READINESS_TONE[readiness.tone];
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
  const outputComplete = requiredFields.total > 0 && missingOutput.length === 0;
  // The per-output missing fields now live in the collapsed Outputs accordion
  // below, so drop the "Waiting on: …" tail from the banner — keep just the
  // lead sentence so the same list isn't shown in two places.
  const bannerDetail = readiness.detail.split(/\s*Waiting on:/)[0].trim();
  // Deduped fields blocking any not-ready (non-excluded) output — surfaced in
  // the collapsed accordion header so blockers are visible without expanding.
  const blockingFieldLabels = Array.from(
    new Set(outputCards.filter((o) => !o.ready && !o.excluded).flatMap((o) => o.missing)),
  );
  return (
    <>
      <div className={`mt-6 flex items-start gap-3 rounded-lg border p-4 ${tone.box}`}>
        <span className={`mt-1 inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ${tone.dot}`} />
        <div>
          <div className="text-sm font-semibold">{readiness.title}</div>
          <div className="mt-0.5 text-sm opacity-90">{bannerDetail}</div>
        </div>
      </div>

      <section className="mt-6 grid grid-cols-3 gap-6">
        {/* 1 — Required COLUMNS: progress toward the auto-generate threshold
            (measured against the customer's required columns). A separate
            check from the output fields in card 2. */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Required columns
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold">{style.completionPct}%</span>
            <span className="text-xs text-zinc-400">filled · auto-runs at ≥ {readiness.threshold}%</span>
          </div>
          <div className="mt-2">
            <CompletionBar
              pct={style.completionPct}
              threshold={readiness.hasProdSpec ? readiness.threshold : null}
              ready={readiness.hasProdSpec && readiness.meetsThreshold}
            />
          </div>
          {missing.length > 0 ? (
            <div className="mt-3">
              <div className="text-xs font-medium text-zinc-500">Missing columns</div>
              <ul className="mt-1 space-y-0.5 text-xs text-zinc-600">
                {missing.slice(0, 8).map((m) => (
                  <li key={m.id}>· {m.label}</li>
                ))}
                {missing.length > 8 && (
                  <li className="text-zinc-400">… and {missing.length - 8} more</li>
                )}
              </ul>
            </div>
          ) : (
            <div className="mt-3 text-xs text-zinc-500">All required columns filled.</div>
          )}
        </div>

        {/* 2 — Required OUTPUT FIELDS: what the enabled outputs actually need to
            render. This is the real "can it generate" gate, and the reason the
            banner can read "Not ready" even when columns are 100%. */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Output fields</div>
          {requiredFields.total > 0 ? (
            <>
              <div className="mt-2 flex items-baseline gap-2">
                <span
                  className={`text-2xl font-semibold tabular-nums ${
                    outputComplete ? "text-emerald-600" : "text-amber-600"
                  }`}
                >
                  {requiredFields.filled}/{requiredFields.total}
                </span>
                <span className="text-xs text-zinc-400">the fields this style&rsquo;s outputs need</span>
              </div>
              {missingOutput.length > 0 ? (
                <div className="mt-3">
                  <div className="text-xs font-medium text-zinc-500">Missing — blocks generation</div>
                  <ul className="mt-1 space-y-0.5 text-xs text-amber-700">
                    {missingOutput.map((l) => (
                      <li key={l}>· {l}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="mt-3 text-xs text-emerald-600">All output fields present.</div>
              )}
            </>
          ) : (
            <div className="mt-2 text-sm text-zinc-400">
              This style&rsquo;s outputs need no detail fields.
            </div>
          )}
        </div>

        {/* 3 — Workflow status + last sync. Same computed pill as the
            /styles list (effective-status.ts) so the two never disagree —
            NOT the stored Style.status, which completion re-evaluation
            used to reset. */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Status</div>
          <div className="mt-2">
            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-sm font-medium ${EFFECTIVE_STATUS_TONE_CLASSES[statusView.tone]}`}
            >
              {statusView.label}
            </span>
          </div>
          <div className="mt-1.5 text-xs text-zinc-500">{statusView.hint}</div>
          <div className="mt-2 text-xs text-zinc-400">Last synced {formatDate(style.lastSyncedAt)}</div>
        </div>
      </section>

      {outputCards.length > 0 && (
        // Collapsed by default (accordion). The header carries the missing
        // fields so blockers show at a glance; each row's live preview only
        // fetches once its card is expanded.
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

      {careDerived.lines.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-700">
              Care instructions · derived from the standard
            </h2>
            <span className="text-xs text-zinc-400">
              The catalogue at /settings/care-labels, filtered by this row&apos;s wash-care symbols.
            </span>
          </div>
          <div className="mt-2 rounded-lg border border-zinc-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                Symbols on row
              </span>
              {careDerived.symbols.length === 0 && (
                <span className="text-xs text-zinc-400">none — only &ldquo;always&rdquo; lines print</span>
              )}
              {careDerived.symbols.map((s) => (
                <span
                  key={s.token}
                  title={s.resolved ? s.name : `Unknown token "${s.token}" — not in the symbol catalogue (no artwork, no care-line suppression). Map it at /settings/washcare-symbols.`}
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                    s.resolved
                      ? "border-zinc-200 bg-zinc-50 text-zinc-700"
                      : "border-amber-300 bg-amber-50 text-amber-800"
                  }`}
                >
                  {s.resolved ? s.name : `⚠ ${s.name}`}
                </span>
              ))}
            </div>
            <ul className="mt-3 space-y-1">
              {careDerived.lines.map((line) => (
                <li
                  key={line.text}
                  className={`flex items-baseline gap-2 text-xs ${
                    line.visible ? "text-zinc-800" : "text-zinc-400"
                  }`}
                >
                  <span
                    className={`mt-0.5 inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                      line.visible ? "bg-emerald-500" : "bg-zinc-300"
                    }`}
                  />
                  <span className={line.visible ? "" : "line-through decoration-zinc-300"}>
                    {line.text}
                  </span>
                  <span className="text-[11px] text-zinc-400">· {line.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-700">Record &amp; links</h2>
          <span className="text-xs text-zinc-400">
            Linked records and source identity — the supplier, prod spec, Monday source, etc.
          </span>
        </div>
        <div className="mt-2 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <dl className="grid grid-cols-1 sm:grid-cols-2">
            {recordFields.map((f, i) => {
              const external = f.href?.startsWith("http");
              return (
                <div
                  key={f.label}
                  className={`flex gap-3 border-t border-zinc-100 px-4 py-2.5 ${
                    i % 2 === 0 ? "sm:border-r" : ""
                  }`}
                >
                  <dt className="w-40 flex-shrink-0 text-xs font-medium uppercase tracking-wide text-zinc-500">
                    {f.label}
                  </dt>
                  <dd className={`flex-1 break-words text-sm ${f.value ? "text-zinc-800" : "text-zinc-300"}`}>
                    {f.value ? (
                      f.href ? (
                        <a
                          href={f.href}
                          className="text-zinc-800 underline hover:text-zinc-950"
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
        </div>
      </section>

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-700">Resolved fields</h2>
          <span className="text-xs text-zinc-400">
            What the PDFs render — resolved from the column mapping.
            {requiredFields.total > 0 && (
              <>
                {" "}
                <span className="rounded bg-zinc-200 px-1 py-px text-[9px] font-semibold uppercase text-zinc-700">
                  req
                </span>{" "}
                = required
              </>
            )}
          </span>
        </div>
        <div className="mt-2 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <dl className="grid grid-cols-1 sm:grid-cols-2">
            {resolvedFields.map((f, i) => {
              const isRequired = requiredSet.has(f.field);
              const isMissing = isRequired && !f.value.trim();
              return (
                <div
                  key={f.field}
                  className={`flex gap-3 border-t border-zinc-100 px-4 py-2.5 ${
                    i % 2 === 0 ? "sm:border-r" : ""
                  } ${isMissing ? "bg-amber-50" : ""}`}
                >
                  <dt className="w-40 flex-shrink-0 text-xs font-medium uppercase tracking-wide text-zinc-500">
                    <span className="flex items-center gap-1.5">
                      {f.label}
                      {isRequired && (
                        <span
                          title="Required field — needed by one of this style's outputs"
                          className={`rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${
                            isMissing ? "bg-amber-200 text-amber-900" : "bg-zinc-200 text-zinc-700"
                          }`}
                        >
                          req
                        </span>
                      )}
                    </span>
                  </dt>
                  <dd
                    className={`flex-1 text-sm break-words ${
                      f.value ? "text-zinc-800" : isMissing ? "text-amber-700" : "text-zinc-300"
                    }`}
                  >
                    {f.field === "ean13" && f.value.includes("=") ? (
                      // Per-size EAN map ("S=570…,M=570…") — one line per
                      // size instead of an unreadable comma run. Duplicate
                      // sizes (multi-colourway POs) keep their own lines,
                      // with the colourway named when the resolved PO rows
                      // know it.
                      <div className="space-y-0.5 font-mono text-xs">
                        {f.value.split(",").map((pair, j) => {
                          const [size, ean] = pair.split("=");
                          const color = eanColor.get(ean?.trim() ?? "");
                          return (
                            <div key={`${pair}-${j}`}>
                              <span className="inline-block w-14 text-zinc-500">{size?.trim()}</span>
                              <span>{ean?.trim()}</span>
                              {color && <span className="ml-2 text-zinc-400">{color}</span>}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      f.value || (isMissing ? "missing" : "—")
                    )}
                    {f.fallback && (
                      <span
                        title={`No mapped value — falling back to the ${f.fallback}`}
                        className="ml-1.5 inline-block rounded bg-sky-100 px-1 py-px align-middle text-[9px] font-medium uppercase tracking-wide text-sky-700"
                      >
                        via {f.fallback}
                      </span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      </section>

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-700">EAN barcodes</h2>
          <span className="text-xs text-zinc-400">Read from the PO PDF — per size, in size order</span>
        </div>
        {style.poNumber && (
          <div className="mt-3">
            <PoPreview styleId={style.id} poNumber={style.poNumber} status={style.eanStatus} />
          </div>
        )}
        <div className="mt-2">
          <EanPanel styleId={style.id} hasPo={Boolean(style.poNumber)} initial={eanView} />
        </div>
      </section>

      {/* Last on the page on purpose: everything above already states the
          facts, so this is for the question those panels didn't happen to
          answer — the one that would otherwise have become a Slack message. */}
      <AskStylePanel styleId={style.id} />

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-zinc-700">Jobs</h2>
        <div className="mt-2 overflow-hidden rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Trigger</th>
                <th className="px-4 py-2">Assets</th>
                <th className="px-4 py-2">Reviewer</th>
                <th className="px-4 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {style.jobs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                    No jobs yet.
                  </td>
                </tr>
              ) : (
                style.jobs.map((j) => (
                  <tr key={j.id} className="border-t border-zinc-100">
                    <td className="px-4 py-2">{j.status}</td>
                    <td className="px-4 py-2 text-zinc-600">{j.triggerSource}</td>
                    <td className="px-4 py-2">{j.assets.length}</td>
                    <td className="px-4 py-2 text-zinc-600">
                      {j.reviewActions[0]?.user.email ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-zinc-500">{formatDate(j.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
