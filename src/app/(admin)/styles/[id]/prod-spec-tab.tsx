import Link from "next/link";
import { ResolvedProdSpecButton } from "./resolved-prod-spec";
import { RelinkBusinessAreaButton } from "./relink-business-area-button";
import { SupplierLinkCard, type SupplierShareInfo } from "./supplier-link-card";
import { UserAvatar } from "@/components/user-avatar";
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
  businessAreaId,
  businessAreaLabel,
  businessAreaText,
  candidateBusinessArea,
  supplier,
  poNumber,
  styleStatus,
  requiredReadiness,
  outputsFilesPreview,
  supplierShare,
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
    <div className="mt-6 flex flex-col gap-8">
      {/* Resolved ProdSpec — collapsed to a button; full detail lives in the
          popup so it no longer dominates the tab. */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-700">Resolved Prod Spec</h2>
        {prodSpec ? (
          <ResolvedProdSpecButton
            prodSpecId={prodSpec.id}
            name={prodSpec.name}
            businessAreaMondayValue={prodSpec.businessArea.mondayValue}
            businessAreaLabel={businessAreaLabel}
            autoGenerateThresholdPct={prodSpec.autoGenerateThresholdPct}
            active={prodSpec.active}
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

      {supplierShare ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-zinc-700">Supplier link</h2>
          <SupplierLinkCard share={supplierShare} />
        </section>
      ) : null}

      {/* Prod Spec runs — the list only. Every generation run for this
          style, newest first: when, what triggered it, status, how many
          files, how far the review got and who owns it. The documents
          themselves render in the Review tab next door. */}
      <section>
        <div className="mb-2 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-700">Prod Spec runs</h2>
            <p className="text-xs text-zinc-500">
              Newest first. Open the files themselves in the Review tab.
            </p>
          </div>
          <Link
            href={`/styles/${styleId}?tab=review`}
            className="text-xs font-medium text-zinc-700 underline hover:text-zinc-900"
          >
            Open files →
          </Link>
        </div>

        {jobs.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
            No runs yet for this style — Re-run to generate.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="px-4 py-2 font-semibold">When</th>
                  <th className="px-4 py-2 font-semibold">Run</th>
                  <th className="px-4 py-2 font-semibold">Trigger</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 text-right font-semibold">Files</th>
                  <th className="px-4 py-2 font-semibold">Review</th>
                  <th className="px-4 py-2 font-semibold">Owner</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const total = job.assets.length;
                  const decided = job.assets.filter(
                    (a) => a.reviewStatus !== "PENDING_REVIEW",
                  ).length;
                  return (
                    <tr key={job.id} className="border-b border-zinc-100 last:border-b-0">
                      <td className="px-4 py-2.5 text-zinc-700">{formatDate(job.createdAt)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-zinc-500">
                        {job.id.slice(-8)}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-zinc-500">
                        {job.triggerSource.toLowerCase().replace(/_/g, " ")}
                      </td>
                      <td className="px-4 py-2.5">
                        <RunStatusPill status={job.status} />
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-zinc-700">{total}</td>
                      <td className="px-4 py-2.5 text-xs text-zinc-500">
                        {total === 0 ? "—" : `${decided}/${total} decided`}
                      </td>
                      <td className="px-4 py-2.5">
                        {job.claimedByName ? (
                          <span
                            className="inline-flex items-center"
                            title={
                              job.claimedAtLabel
                                ? `${job.claimedByName} · since ${job.claimedAtLabel}`
                                : job.claimedByName
                            }
                          >
                            <UserAvatar name={job.claimedByName} />
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {job.status === "AWAITING_REVIEW" ? (
                          <Link
                            href={`/styles/${styleId}/review`}
                            className="inline-block rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-800"
                          >
                            Review
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// Status pill, coloured by where the run is in its lifecycle.
function RunStatusPill({ status }: { status: string }) {
  const label = status.toLowerCase().replace(/_/g, " ");
  const tone =
    status === "APPROVED"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : status === "REJECTED" || status === "FAILED"
        ? "border-red-200 bg-red-50 text-red-700"
        : status === "AWAITING_REVIEW"
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : status === "RUNNING" || status === "QUEUED"
            ? "border-blue-200 bg-blue-50 text-blue-700"
            : "border-zinc-200 bg-zinc-100 text-zinc-700";
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone}`}
    >
      {label}
    </span>
  );
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
