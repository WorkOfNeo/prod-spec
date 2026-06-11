import Link from "next/link";
import { DeliveredCard } from "./delivered-card";
import { groupByDocType, DocTypeAccordion } from "./doc-type-groups";
import { UserAvatar } from "@/components/user-avatar";
import { formatDate } from "@/lib/utils";

// The style page's Review tab — the ONE place to look at generated files.
// The Prod Spec tab next door lists the runs (timestamps, counts, owner);
// this tab shows the latest run's documents in a grid (up to 4 across) with
// older runs collapsed below. Deciding still happens on the dedicated
// review screen (leave guard, claim popup) — the CTA appears whenever the
// latest run is awaiting review.

export type ReviewTabAsset = {
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

export type ReviewTabJob = {
  id: string;
  status: string;
  triggerSource: string;
  createdAt: string;
  // The review owner — who pressed "Start review" (or decided first).
  claimedByName: string | null;
  claimedAtLabel: string | null;
  assets: ReviewTabAsset[];
};

// Up to 4 documents per row, per the review workflow ask.
const FILE_GRID = "grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

export function ReviewTab({ styleId, jobs }: { styleId: string; jobs: ReviewTabJob[] }) {
  // Assets sorted by fileName, not query order: rows land in one
  // transaction (tied timestamps), and the runner's 00-cover / 01-general-
  // information prefixes are designed to open every bundle listing.
  const sortedJobs = jobs.map((j) => ({
    ...j,
    assets: [...j.assets].sort((a, b) => a.fileName.localeCompare(b.fileName)),
  }));
  const latestJob = sortedJobs[0] ?? null;
  const olderJobs = sortedJobs.slice(1);

  return (
    <div className="mt-6 flex flex-col gap-8">
      <section>
        <div className="mb-2 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-700">Files — latest run</h2>
            <p className="text-xs text-zinc-500">
              {latestJob
                ? `Job ${latestJob.id.slice(-8)} · ${formatDate(latestJob.createdAt)} · ${latestJob.assets.length} file${latestJob.assets.length === 1 ? "" : "s"}`
                : "No run yet — Re-run to generate."}
            </p>
            {latestJob?.claimedByName ? (
              <span className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-zinc-600">
                <UserAvatar name={latestJob.claimedByName} />
                <span>
                  <b>{latestJob.claimedByName}</b> owns this review
                  {latestJob.claimedAtLabel ? <> · since {latestJob.claimedAtLabel}</> : null}
                </span>
              </span>
            ) : null}
          </div>
          {latestJob?.status === "AWAITING_REVIEW" ? (
            <Link
              href={`/styles/${styleId}/review`}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
            >
              Review &amp; decide
            </Link>
          ) : null}
        </div>

        {!latestJob || latestJob.assets.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
            Nothing generated yet for this style.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {groupByDocType(latestJob.assets).map((group) => (
              <DocTypeAccordion key={group.docType} label={group.label} count={group.items.length}>
                <div className={FILE_GRID}>
                  {group.items.map((asset) => (
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
              </DocTypeAccordion>
            ))}
          </div>
        )}
      </section>

      {/* Older runs — historical generations are kept (each Re-run creates
          a new Job row). Collapsed so the page doesn't grow unbounded. */}
      {olderJobs.length > 0 && (
        <section>
          <details className="group rounded-lg border border-zinc-200 bg-white">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50">
              <span className="inline-flex items-center gap-2">
                <ChevronIcon />
                Previous runs ({olderJobs.length})
              </span>
              <span className="ml-2 text-xs font-normal text-zinc-500">
                Earlier generations are kept in full — open to browse.
              </span>
            </summary>
            <div className="border-t border-zinc-100 px-4 py-4">
              <div className="flex flex-col gap-6">
                {olderJobs.map((job) => (
                  <div key={job.id}>
                    <div className="mb-2 flex items-baseline justify-between gap-3 text-xs text-zinc-500">
                      <span className="inline-flex items-center gap-2">
                        <span className="font-mono">job {job.id.slice(-8)}</span> ·{" "}
                        {formatDate(job.createdAt)} ·{" "}
                        {job.triggerSource.toLowerCase().replace(/_/g, " ")}
                        {job.claimedByName ? <UserAvatar name={job.claimedByName} size="xs" /> : null}
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
                      <div className={FILE_GRID}>
                        {job.assets.map((asset) => (
                          <DeliveredCard
                            key={asset.id}
                            jobId={job.id}
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

function defaultDisplayName(docType: string): string {
  return docType
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
