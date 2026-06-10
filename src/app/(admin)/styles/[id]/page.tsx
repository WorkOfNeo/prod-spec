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
import { findMissingDetailFields } from "@/lib/styles/detail-fields";
import { computeReadiness, type Readiness, type ReadinessTone } from "@/lib/styles/readiness";
import { outputReadinessForStyle, type OutputReadiness } from "@/lib/styles/output-readiness";
import { RerunButton } from "./rerun-button";
import { StyleOutputCard, type StyleOutputCardProps } from "./style-output-card";
import { ProdSpecTab } from "./prod-spec-tab";
import { EanPanel } from "./ean-panel";
import type { EanView } from "@/lib/po/ean-view";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { requiredFieldsForVariants, getVariant } from "@/lib/pdf/template-registry";
import { parseCustomerConfig } from "@/lib/customers/config";
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

type TabKey = "details" | "prod-spec";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "details", label: "Details" },
  { key: "prod-spec", label: "Prod Spec" },
];

export default async function StyleDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const tabParam = (await searchParams).tab;
  const tab: TabKey = tabParam === "prod-spec" ? "prod-spec" : "details";

  const style = await db.style.findUnique({
    where: { id },
    include: {
      customer: true,
      supplier: true,
      businessAreaRef: true,
      qrImage: { select: { name: true } },
      eans: { orderBy: { position: "asc" } },
      prodSpec: { include: { businessArea: true, suppliers: { include: { supplier: true } } } },
      jobs: {
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
    select: { id: true, jobId: true, variantKey: true, createdAt: true },
    take: 400,
  });
  const latestAssetByVariant = new Map<string, { id: string; jobId: string; createdAt: Date }>();
  for (const a of recentAssets) {
    if (a.variantKey && !latestAssetByVariant.has(a.variantKey)) {
      latestAssetByVariant.set(a.variantKey, { id: a.id, jobId: a.jobId, createdAt: a.createdAt });
    }
  }

  const latestJob = style.jobs[0];
  const missing = (style.missingFields as Array<{ id: string; label: string }>) ?? [];

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
  const reqMapping = parseCustomerConfig(style.customer.config).columnMapping;
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
    ? outputReadinessForStyle({
        rawData: style.rawData,
        poNumber: style.poNumber,
        supplier: style.supplier,
        eans: style.eans,
        cartonEan: style.cartonEan,
        customer: { config: style.customer.config },
        prodSpec: { outputs: style.prodSpec.outputs, columnMapping: {} },
      })
    : [];

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

  // Per-output card props — live preview src, missing/pin/note chips, last
  // generated artifact. Computed here (not in DetailsTab) because they need
  // the effective item + mapping + parsed output entries.
  const outputCards: StyleOutputCardProps[] = outputReadiness.map((o) => {
    const asset = latestAssetByVariant.get(o.variantKey);
    const query = `variantKey=${encodeURIComponent(o.variantKey)}`;
    const entry = outputEntryByKey.get(o.variantKey);
    const variant = getVariant(o.variantKey);
    const pins = Object.entries(parseFieldOverrides(entry?.fieldOverrides)).map(
      ([field, value]) => ({
        label: PINNABLE_FIELD_LABELS[field as PinnableField],
        value: value as string,
      }),
    );
    return {
      styleId: style.id,
      variantKey: o.variantKey,
      name: o.name,
      ready: o.ready,
      missing: o.missing.map((m) => m.label),
      widthMm: entry?.widthMm ?? variant?.defaultWidthMm ?? 100,
      heightMm: entry?.heightMm ?? variant?.defaultHeightMm ?? 100,
      pins,
      notes: outputDataNotes(o.variantKey, effItem, reqMapping),
      thumbSrc: asset
        ? `/api/admin/jobs/${asset.jobId}/thumbnail?${query}&v=${asset.id}`
        : null,
      pdfHref: asset
        ? `/api/admin/jobs/${asset.jobId}/preview?${query}#zoom=fit&toolbar=0&navpanes=0`
        : null,
      generatedAt: asset ? formatDate(asset.createdAt) : null,
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
    sizeEans: style.eans.map((e) => ({
      size: e.size,
      ean13: e.ean13,
      variantLabel: e.variantLabel,
    })),
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

  return (
    <div className="px-8 py-8">
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
          <Link
            href={`/styles/${style.id}/edit`}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Edit
          </Link>
          <RerunButton
            styleId={style.id}
            disabled={latestJob?.status === "RUNNING" || latestJob?.status === "QUEUED"}
          />
        </div>
      </div>

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
          jobs={style.jobs.map((j) => ({
            id: j.id,
            status: j.status,
            triggerSource: j.triggerSource,
            createdAt: j.createdAt.toISOString(),
            assets: j.assets.map((a) => ({
              id: a.id,
              docType: a.docType,
              variantKey: a.variantKey,
              displayName: a.displayName,
              fileName: a.fileName,
              reviewStatus: a.reviewStatus,
              rejectReason: a.rejectReason,
              reviewedAt: a.reviewedAt?.toISOString() ?? null,
              reviewerEmail: a.reviewedBy?.email ?? null,
            })),
          }))}
        />
      )}
    </div>
  );
}

function DetailsTab({
  style,
  missing,
  resolvedFields,
  recordFields,
  readiness,
  eanView,
  requiredFieldKeys,
  requiredFields,
  outputCards,
  careDerived,
}: {
  style: NonNullable<Awaited<ReturnType<typeof db.style.findUnique>>> & {
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
  // Output fields the enabled outputs need but that are empty — the real
  // "can it generate" gate, distinct from the required-columns completion %.
  const missingOutput = requiredFields.fields.filter((f) => !f.ok).map((f) => f.label);
  const outputComplete = requiredFields.total > 0 && missingOutput.length === 0;
  return (
    <>
      <div className={`mt-6 flex items-start gap-3 rounded-lg border p-4 ${tone.box}`}>
        <span className={`mt-1 inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ${tone.dot}`} />
        <div>
          <div className="text-sm font-semibold">{readiness.title}</div>
          <div className="mt-0.5 text-sm opacity-90">{readiness.detail}</div>
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

        {/* 3 — Workflow status + last sync. */}
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Status</div>
          <div className="mt-2 text-lg">{style.status.toLowerCase().replace(/_/g, " ")}</div>
          <div className="mt-2 text-xs text-zinc-400">Last synced {formatDate(style.lastSyncedAt)}</div>
        </div>
      </section>

      {outputCards.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-700">
              Outputs · {outputCards.filter((o) => o.ready).length} of {outputCards.length} ready
            </h2>
            <span className="text-xs text-zinc-400">
              Live previews render from the row&apos;s current data — run each output on its own as it
              goes ready.
            </span>
          </div>
          {/* Live preview cards. Each card also keeps the LAST GENERATED
              artifact (thumbnail + PDF link) in its footer — the two differ,
              visibly and by design, when the row changed after the last run. */}
          <div className="mt-2 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {outputCards.map((card) => (
              <StyleOutputCard key={card.variantKey} {...card} />
            ))}
          </div>
        </section>
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
                      // sizes (multi-colourway POs) keep their own lines.
                      <div className="space-y-0.5 font-mono text-xs">
                        {f.value.split(",").map((pair, j) => {
                          const [size, ean] = pair.split("=");
                          return (
                            <div key={`${pair}-${j}`}>
                              <span className="inline-block w-14 text-zinc-500">{size?.trim()}</span>
                              <span>{ean?.trim()}</span>
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
        <div className="mt-2">
          <EanPanel styleId={style.id} hasPo={Boolean(style.poNumber)} initial={eanView} />
        </div>
      </section>

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
