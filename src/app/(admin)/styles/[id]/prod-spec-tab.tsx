import Link from "next/link";
import { DeliveredCard } from "./delivered-card";
import { RelinkBusinessAreaButton } from "./relink-business-area-button";
import { formatDate } from "@/lib/utils";

type ProdSpec = {
  id: string;
  name: string;
  autoGenerateThresholdPct: number;
  active: boolean;
  businessArea: { id: string; name: string; mondayValue: string };
  suppliers: Array<{ supplier: { id: string; name: string; country: string | null } }>;
};

type Supplier = {
  id: string;
  name: string;
  country: string | null;
} | null;

type DeliveredAsset = {
  id: string;
  docType: string;
  variantKey: string | null;
  displayName: string | null;
  fileName: string;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  rejectReason: string | null;
  reviewedAt: string | null;
  reviewerEmail: string | null;
};

type DeliveredJob = {
  id: string;
  status: string;
  triggerSource: string;
  createdAt: string;
  assets: DeliveredAsset[];
};

export function ProdSpecTab({
  styleId,
  prodSpec,
  customerId,
  businessAreaId,
  businessAreaLabel,
  businessAreaText,
  candidateBusinessArea,
  supplier,
  poNumber,
  styleStatus,
  requiredReadiness,
  jobs,
}: {
  styleId: string;
  prodSpec: ProdSpec | null;
  customerId: string;
  businessAreaId: string | null;
  businessAreaLabel: string | null;
  // The raw `Style.businessArea` text fallback (set by webhook or older
  // manual creates). Surfaced so the operator can see the disconnect
  // between text-set vs FK-set.
  businessAreaText: string | null;
  // Pre-computed match for the relink action: if there's an active
  // BusinessArea row whose mondayValue/name matches `businessAreaText`,
  // we render a one-click button to link it.
  candidateBusinessArea: { id: string; name: string; mondayValue: string } | null;
  supplier: Supplier;
  poNumber: string | null;
  // Workflow status of the parent Style — drives the ready/approved badge.
  styleStatus: string;
  // Required-field readiness for the ProdSpec that will run — the UNION of
  // the fields each enabled output needs. filled/total plus a per-field ok
  // flag for the checklist.
  requiredReadiness: {
    filled: number;
    total: number;
    fields: Array<{ label: string; ok: boolean }>;
  };
  // ALL recent jobs, latest first. Latest renders the prominent
  // "Delivered Prod Specs" grid; the rest are tucked into a collapsible
  // accordion below so historical jobs (and their assets) stay
  // reachable without crowding the page.
  jobs: DeliveredJob[];
}) {
  const latestJob = jobs[0] ?? null;
  const olderJobs = jobs.slice(1);
  return (
    <div className="mt-6 flex flex-col gap-8">
      {/* Resolved ProdSpec */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-700">Resolved Prod Spec</h2>
        {prodSpec ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs uppercase tracking-wide text-zinc-500">Auto-resolved</div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="text-lg font-semibold">{prodSpec.name}</span>
                  <ReadyBadge
                    styleStatus={styleStatus}
                    filled={requiredReadiness.filled}
                    total={requiredReadiness.total}
                  />
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  Business area: <span className="font-mono">{prodSpec.businessArea.mondayValue}</span> ·
                  threshold {prodSpec.autoGenerateThresholdPct}% · {prodSpec.active ? "active" : "inactive"}
                </div>
              </div>
              <Link
                href={`/prod-specs/${prodSpec.id}`}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Edit prod spec →
              </Link>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-4 text-xs">
              <Field label="Business area">{businessAreaLabel ?? "—"}</Field>
              <Field label="PO Number">{poNumber ?? "—"}</Field>
              <Field label="Supplier (style)">
                {supplier ? supplier.name : "—"}
              </Field>
            </div>

            <div className="mt-4 border-t border-zinc-100 pt-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Required fields (from selected outputs)
                </div>
                {requiredReadiness.total > 0 && (
                  <span
                    className={`text-xs font-semibold tabular-nums ${
                      requiredReadiness.filled === requiredReadiness.total
                        ? "text-emerald-600"
                        : "text-amber-600"
                    }`}
                  >
                    {requiredReadiness.filled}/{requiredReadiness.total}
                  </span>
                )}
              </div>
              {requiredReadiness.total === 0 ? (
                <p className="mt-2 text-xs text-zinc-400">
                  No outputs selected yet — pick outputs on the prod spec to see required fields.
                </p>
              ) : (
                <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
                  {requiredReadiness.fields.map((f, i) => (
                    <li key={i} className="flex items-center gap-1.5">
                      <span className={f.ok ? "text-emerald-600" : "text-amber-600"}>
                        {f.ok ? "✓" : "✗"}
                      </span>
                      <span className={f.ok ? "text-zinc-700" : "font-medium text-amber-700"}>
                        {f.label}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="mt-4">
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Suppliers attached to this ProdSpec
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {prodSpec.suppliers.length === 0 ? (
                  <span className="text-xs text-zinc-500">— none —</span>
                ) : (
                  prodSpec.suppliers.map(({ supplier: s }) => (
                    <span
                      key={s.id}
                      className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-3 py-1 text-xs"
                    >
                      <span className="font-medium">{s.name}</span>
                      {s.country && <span className="text-zinc-500">· {s.country}</span>}
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : (
          <NoProdSpecBlock
            styleId={styleId}
            customerId={customerId}
            businessAreaId={businessAreaId}
            businessAreaText={businessAreaText}
            candidateBusinessArea={candidateBusinessArea}
          />
        )}
      </section>

      {/* Delivered Prod Specs (the generated PDFs from the latest job) */}
      <section>
        <div className="mb-2 flex items-end justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-700">Delivered Prod Specs</h2>
            <p className="text-xs text-zinc-500">
              {latestJob
                ? `From job ${latestJob.id.slice(-8)} · ${formatDate(latestJob.createdAt)}`
                : "No job yet — Re-run to generate."}
            </p>
          </div>
        </div>

        {!latestJob || latestJob.assets.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
            Nothing generated yet for this style.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {latestJob.assets.map((asset) => (
              <DeliveredCard
                key={asset.id}
                jobId={latestJob.id}
                asset={{
                  id: asset.id,
                  docType: asset.docType,
                  variantKey: asset.variantKey,
                  displayName: asset.displayName ?? defaultDisplayName(asset.docType),
                  fileName: asset.fileName,
                  reviewStatus: asset.reviewStatus,
                  rejectReason: asset.rejectReason,
                  reviewedAt: asset.reviewedAt,
                  reviewerEmail: asset.reviewerEmail,
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* Older jobs — historical generations are kept (each Re-run
          creates a new Job row, not in-place replacement). Tucked into
          an accordion so the page doesn't grow unbounded but the data
          is one click away. Each block shows the same DeliveredCard
          grid as the latest section. */}
      {olderJobs.length > 0 && (
        <section>
          <details className="group rounded-lg border border-zinc-200 bg-white">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50">
              <span className="inline-flex items-center gap-2">
                <ChevronIcon />
                Previous Prod Specs ({olderJobs.length})
              </span>
              <span className="ml-2 text-xs font-normal text-zinc-500">
                Earlier Re-runs are kept in full — open to browse.
              </span>
            </summary>
            <div className="border-t border-zinc-100 px-4 py-4">
              <div className="flex flex-col gap-6">
                {olderJobs.map((job) => (
                  <div key={job.id}>
                    <div className="mb-2 flex items-baseline justify-between gap-3 text-xs text-zinc-500">
                      <span>
                        <span className="font-mono">job {job.id.slice(-8)}</span> ·{" "}
                        {formatDate(job.createdAt)} · {job.triggerSource.toLowerCase().replace(/_/g, " ")}
                      </span>
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-700">
                        {job.status.toLowerCase().replace(/_/g, " ")}
                      </span>
                    </div>
                    {job.assets.length === 0 ? (
                      <div className="rounded-lg border border-zinc-100 bg-zinc-50 px-4 py-3 text-xs text-zinc-500">
                        No assets generated.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {job.assets.map((asset) => (
                          <DeliveredCard
                            key={asset.id}
                            jobId={job.id}
                            asset={{
                              id: asset.id,
                              docType: asset.docType,
                              variantKey: asset.variantKey,
                              displayName:
                                asset.displayName ?? defaultDisplayName(asset.docType),
                              fileName: asset.fileName,
                              reviewStatus: asset.reviewStatus,
                              rejectReason: asset.rejectReason,
                              reviewedAt: asset.reviewedAt,
                              reviewerEmail: asset.reviewerEmail,
                            }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </details>
        </section>
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 text-zinc-500 transition-transform group-open:rotate-90"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// Readiness badge for the ProdSpec that will run. Pre-generation it reflects
// required-field completion ("3/5" not-ready → "✓ ready"); once a job runs it
// follows the Style's workflow status (generating → awaiting review →
// approved / rejected).
function ReadyBadge({
  styleStatus,
  filled,
  total,
}: {
  styleStatus: string;
  filled: number;
  total: number;
}) {
  const s = (() => {
    switch (styleStatus) {
      case "APPROVED":
        return { label: "approved", cls: "bg-emerald-100 text-emerald-800", check: true };
      case "REJECTED":
        return { label: "rejected", cls: "bg-red-100 text-red-700", check: false };
      case "AWAITING_REVIEW":
        return { label: "awaiting review", cls: "bg-purple-100 text-purple-800", check: false };
      case "GENERATING":
        return { label: "generating", cls: "bg-blue-100 text-blue-800", check: false };
      default:
        if (total > 0 && filled < total)
          return { label: `${filled}/${total}`, cls: "bg-amber-100 text-amber-800", check: false };
        return { label: "ready", cls: "bg-emerald-100 text-emerald-800", check: true };
    }
  })();
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.cls}`}
    >
      {s.check && <span aria-hidden>✓</span>}
      {s.label}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-zinc-500">{label}</div>
      <div className="font-medium">{children}</div>
    </div>
  );
}

function defaultDisplayName(docType: string): string {
  return docType
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// "No Prod Spec resolved" amber panel. Two flavours:
//   - FK missing (businessAreaId null) — by far the common case. Splits
//     into "no text, no FK" (just go Edit) vs "text present but FK
//     missing" (offer one-click relink to the matching BA row).
//   - FK set but no ProdSpec — rare; means the BA was deactivated
//     between Style create and now. Direct the operator to /prod-specs.
function NoProdSpecBlock({
  styleId,
  customerId,
  businessAreaId,
  businessAreaText,
  candidateBusinessArea,
}: {
  styleId: string;
  customerId: string;
  businessAreaId: string | null;
  businessAreaText: string | null;
  candidateBusinessArea: { id: string; name: string; mondayValue: string } | null;
}) {
  const hasText = !!businessAreaText && businessAreaText.trim().length > 0;
  const fkMissing = !businessAreaId;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
      <p className="font-medium">No Prod Spec resolved for this style.</p>

      <p className="mt-1 text-xs">
        Auto-resolution needs both a Customer and a Business Area on the Style. Currently: customer
        ✓, business area FK {businessAreaId ? "✓" : "✗"}
        {hasText && (
          <>
            {" "}
            (Style has business-area text{" "}
            <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-[11px]">
              {businessAreaText}
            </code>
            {fkMissing && " but no linked BusinessArea row"})
          </>
        )}
        .
      </p>

      {fkMissing && candidateBusinessArea && (
        <>
          <p className="mt-2 text-xs">
            Found an active Business Area row matching that text — one click will link it and create
            the ProdSpec.
          </p>
          <RelinkBusinessAreaButton styleId={styleId} candidate={candidateBusinessArea} />
        </>
      )}

      <p className="mt-2 text-xs">
        Or set the Business Area in{" "}
        <Link href={`./edit`} className="underline">
          Edit
        </Link>{" "}
        — or create a ProdSpec manually at{" "}
        <Link href={`/prod-specs`} className="underline">
          /prod-specs
        </Link>{" "}
        for customer {customerId.slice(-8)}.
      </p>
    </div>
  );
}
