import Link from "next/link";
import { ResolvedProdSpecButton } from "./resolved-prod-spec";
import { RelinkBusinessAreaButton } from "./relink-business-area-button";
import { SupplierLinkCard, type SupplierShareInfo } from "./supplier-link-card";
import { UserAvatar } from "@/components/user-avatar";
import { formatDate } from "@/lib/utils";
import { triggerLabel } from "@/lib/queue/trigger-labels";
import { buttonClass } from "@/components/ui/button";
import { Pill, type PillTone } from "@/components/ui/pill";

type ProdSpec = {
  id: string;
  name: string;
  autoGenerateThresholdPct: number;
  active: boolean;
  fullyApproved: boolean;
  businessArea: { id: string; name: string; mondayValue: string };
  suppliers: Array<{ supplier: { id: string; name: string; country: string | null } }>;
};

type Supplier = {
  id: string;
  name: string;
  country: string | null;
} | null;

type RunAsset = {
  id: string;
  reviewStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
};

export type ProdSpecRun = {
  id: string;
  status: string;
  triggerSource: string;
  createdAt: string;
  // The review owner — who pressed "Start review" (or decided first).
  claimedByName: string | null;
  claimedAtLabel: string | null;
  assets: RunAsset[];
};

export function ProdSpecTab({
  styleId,
  prodSpec,
  customerId,
  customerName,
  businessAreaId,
  businessAreaLabel,
  businessAreaText,
  candidateBusinessArea,
  supplier,
  poNumber,
  styleStatus,
  enabledOutputCount,
  requiredReadiness,
  outputsFilesPreview,
  supplierShare,
  jobs,
}: {
  styleId: string;
  prodSpec: ProdSpec | null;
  customerId: string;
  customerName: string;
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
  enabledOutputCount: number;
  // Required-field readiness for the ProdSpec that will run — the UNION of
  // the fields each enabled output needs. filled/total plus a per-field ok
  // flag for the checklist.
  requiredReadiness: {
    filled: number;
    total: number;
    fields: Array<{ label: string; ok: boolean }>;
  };
  // Pre-run files preview — per enabled output, the PDFs the NEXT run
  // would emit (count + resolved names, repeat/split aware). Shown in
  // the popup so the operator can verify split settings before running.
  outputsFilesPreview: Array<{ variantKey: string; name: string; known: boolean; files: string[] }>;
  // The style's durable supplier share (null until approved at least once).
  // The link always serves the latest approved version, so there's no
  // staleness to flag — just show it and the visit status.
  supplierShare: SupplierShareInfo | null;
  // ALL recent runs, latest first. This tab shows the LIST only —
  // timestamps, file counts, review progress, owner. The files themselves
  // live in the Review tab.
  jobs: ProdSpecRun[];
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      {/* Runs — every generation for this style, newest first: when, what
          triggered it, status, how many files, how far the review got and who
          owns it. The documents themselves are on the Review tab. */}
      <section data-section="Runs" className="border-line bg-surface overflow-hidden rounded-xl border">
        <div className="border-line flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
          <div>
            <h2 className="text-ink text-[14px] font-semibold">Runs</h2>
            <p className="text-muted text-[12px]">
              Timestamps, counts and owner per generation. The Review tab shows the files themselves.
            </p>
          </div>
          {jobs.length > 0 && jobs[0].assets.length > 0 ? (
            <a
              href={`/api/admin/jobs/${jobs[0].id}/download-zip`}
              className={buttonClass("secondary", "sm")}
              title="Download every PDF of the latest run as one zip, under their print file names"
            >
              <DownloadIcon />
              Latest run (.zip)
            </a>
          ) : null}
        </div>
        {jobs.length === 0 ? (
          <p className="text-muted px-4 py-8 text-center text-[13px]">No runs yet for this style. Re-run to generate.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-line text-muted border-b text-left text-[12px]">
                  <th className="px-4 py-2 font-medium">Run</th>
                  <th className="px-3 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 text-right font-medium">Outputs</th>
                  <th className="px-3 py-2 font-medium">Review</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {jobs.map((job) => {
                  const total = job.assets.length;
                  const decided = job.assets.filter((a) => a.reviewStatus !== "PENDING_REVIEW").length;
                  return (
                    <tr key={job.id}>
                      <td className="px-4 py-2.5">
                        <div className="text-ink">{triggerLabel(job.triggerSource)}</div>
                        <div className="text-faint font-mono text-[11px]">{job.id.slice(-8)}</div>
                      </td>
                      <td className="text-muted px-3 py-2.5 whitespace-nowrap">{formatDate(job.createdAt)}</td>
                      <td className="text-ink px-3 py-2.5 text-right tabular-nums">{total}</td>
                      <td className="text-muted px-3 py-2.5 whitespace-nowrap">{total === 0 ? "—" : `${decided}/${total} decided`}</td>
                      <td className="px-3 py-2.5">
                        {job.claimedByName ? (
                          <span
                            data-private
                            className="inline-flex items-center"
                            title={job.claimedAtLabel ? `${job.claimedByName} · since ${job.claimedAtLabel}` : job.claimedByName}
                          >
                            <UserAvatar name={job.claimedByName} />
                          </span>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <RunStatusPill status={job.status} />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="inline-flex items-center gap-2">
                          {total > 0 && (
                            <a
                              href={`/api/admin/jobs/${job.id}/download-zip`}
                              className="text-muted hover:text-ink inline-flex items-center gap-1 text-[12px]"
                              title="Download this run's PDFs as one zip, under their print file names"
                            >
                              <DownloadIcon />
                              zip
                            </a>
                          )}
                          {job.status === "AWAITING_REVIEW" ? (
                            <Link href={`/styles/${styleId}/review`} className={buttonClass("primary", "sm")}>
                              Review
                            </Link>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="flex flex-col gap-4">
        <section data-section="Resolved prod spec" className="border-line bg-surface overflow-hidden rounded-xl border">
          <div className="border-line flex items-start justify-between gap-3 border-b px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-ink text-[14px] font-semibold">Prod spec</h2>
              <p className="text-muted truncate text-[12px]">{prodSpec ? prodSpec.name : "None resolved"}</p>
            </div>
            {prodSpec ? (
              <Link href={`/prod-specs/${prodSpec.id}`} className={buttonClass("secondary", "sm")}>
                Open
              </Link>
            ) : null}
          </div>
          {prodSpec ? (
            <>
              <dl className="divide-line divide-y text-[13px]">
                <SpecField label="Customer" value={customerName} />
                <SpecField label="Business area" value={businessAreaLabel ?? prodSpec.businessArea.name} />
                <SpecField label="Outputs" value={`${enabledOutputCount} enabled`} />
                <SpecField
                  label="Required fields"
                  value={requiredReadiness.total > 0 ? `${requiredReadiness.filled} of ${requiredReadiness.total} filled` : "None needed"}
                />
                <SpecField label="Auto-run" value={`When ${prodSpec.autoGenerateThresholdPct}% of the required columns are filled`} />
                <SpecField
                  label="State"
                  value={`${prodSpec.active ? "Active" : "Inactive"}${prodSpec.fullyApproved ? " · fully approved" : ""}`}
                />
              </dl>
              {/* The full picture — required-field checklist, files the next
                  run would emit, attached suppliers — lives in this popup. */}
              <div className="border-line border-t px-4 py-2.5">
                <ResolvedProdSpecButton
                  prodSpecId={prodSpec.id}
                  name={prodSpec.name}
                  businessAreaMondayValue={prodSpec.businessArea.mondayValue}
                  businessAreaLabel={businessAreaLabel}
                  autoGenerateThresholdPct={prodSpec.autoGenerateThresholdPct}
                  active={prodSpec.active}
                  fullyApproved={prodSpec.fullyApproved}
                  poNumber={poNumber}
                  supplierName={supplier?.name ?? null}
                  suppliers={prodSpec.suppliers.map(({ supplier: s }) => ({
                    id: s.id,
                    name: s.name,
                    country: s.country,
                  }))}
                  styleStatus={styleStatus}
                  requiredReadiness={requiredReadiness}
                  outputsFilesPreview={outputsFilesPreview}
                />
              </div>
            </>
          ) : (
            <div className="p-4">
              <NoProdSpecBlock
                styleId={styleId}
                customerId={customerId}
                businessAreaId={businessAreaId}
                businessAreaText={businessAreaText}
                candidateBusinessArea={candidateBusinessArea}
              />
            </div>
          )}
        </section>

        {supplierShare ? <SupplierLinkCard share={supplierShare} /> : null}
      </div>
    </div>
  );
}

function SpecField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 px-4 py-2">
      <dt className="text-muted w-32 shrink-0 text-[12px] leading-5">{label}</dt>
      <dd className="text-ink min-w-0 flex-1">{value}</dd>
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

// Status pill, coloured by where the run is in its lifecycle.
function RunStatusPill({ status }: { status: string }) {
  const label = status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
  const tone: PillTone =
    status === "APPROVED"
      ? "good"
      : status === "REJECTED" || status === "FAILED"
        ? "bad"
        : status === "AWAITING_REVIEW"
          ? "warn"
          : status === "RUNNING" || status === "QUEUED"
            ? "accent"
            : "neutral";
  return <Pill tone={tone}>{label}</Pill>;
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
    <div className="rounded-lg border border-transparent bg-warn-soft p-5 text-sm text-warn">
      <p className="font-medium">No Prod Spec resolved for this style.</p>

      <p className="mt-1 text-xs">
        Auto-resolution needs both a Customer and a Business Area on the Style. Currently: customer
        ✓, business area FK {businessAreaId ? "✓" : "✗"}
        {hasText && (
          <>
            {" "}
            (Style has business-area text{" "}
            <code className="rounded bg-warn-soft px-1 py-0.5 font-mono text-[11px]">
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
