import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/utils";
import {
  resolveStyleSpecFields,
  STYLE_FIELD_LABELS,
  effectiveStyleItem,
  type ResolvedSpecField,
} from "@/lib/styles/resolved-fields";
import { getAutoGenerateEnabled } from "@/lib/settings/app-settings";
import { findMissingDetailFields } from "@/lib/styles/detail-fields";
import { computeReadiness, type Readiness, type ReadinessTone } from "@/lib/styles/readiness";
import { outputReadinessForStyle } from "@/lib/styles/output-readiness";
import { RerunButton } from "./rerun-button";
import { ProdSpecTab } from "./prod-spec-tab";
import { EanPanel } from "./ean-panel";
import type { EanView } from "@/lib/po/ean-view";
import { parseProdSpecOutputs } from "@/lib/prod-spec/config";
import { requiredFieldsForVariants } from "@/lib/pdf/template-registry";
import { parseCustomerConfig } from "@/lib/customers/config";

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

  const latestJob = style.jobs[0];
  const missing = (style.missingFields as Array<{ id: string; label: string }>) ?? [];

  const autoGenerateEnabled = await getAutoGenerateEnabled();

  // Required-field set for this style = the UNION of the fields each ENABLED
  // output on its ProdSpec declares it needs (template-registry). Single
  // source of truth for the readiness banner, the Resolved-fields highlight,
  // and the Prod Spec tab badge/checklist — a style needs exactly what the
  // labels it will print need.
  const enabledVariantKeys = parseProdSpecOutputs(style.prodSpec?.outputs ?? [])
    .filter((o) => o.enabled !== false)
    .map((o) => o.variantKey);
  const requiredKeys = requiredFieldsForVariants(enabledVariantKeys);
  const reqMapping = parseCustomerConfig(style.customer.config).columnMapping;
  const missingDetail = findMissingDetailFields(effectiveStyleItem(style), reqMapping, requiredKeys);
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
                    {f.value || (isMissing ? "missing" : "—")}
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
