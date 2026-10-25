import { DeliveredCard } from "./delivered-card";
import { ManualTrimsPanel } from "./manual-trims-panel";
import { ReviewGallery, type GalleryItem } from "./review-gallery";
import { UserAvatar } from "@/components/user-avatar";
import { docTypeLabel } from "@/lib/pdf/doc-types";
import { formatDate } from "@/lib/utils";

// The style page's Review tab — the ONE place to look at generated files.
// The Prod Spec tab next door lists the runs (timestamps, counts, owner);
// this tab shows the style's CURRENT outputs in a grid (up to 4 across) —
// the latest document per output across ALL runs, the same set /review
// decides on — with the full per-run history collapsed below. Showing the
// current set (not just the newest job) means a fully-approved style's
// approved layouts always appear here, even though durable approval and
// per-output reruns leave them scattered across several jobs. Deciding still
// happens on the dedicated review screen (leave guard, claim popup) — the CTA
// appears whenever the latest run is awaiting review.
//
// "Manually supplied packaging" sits here too, directly under the current
// outputs: this tab is where a person looks at the documents a style ships
// with, and a manual line is simply the document that arrives from outside
// the app instead of out of a run. Same reviewer, same question ("is
// everything here?"), so the two halves belong on one screen.

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
  // Set for carton-capable outputs → the card shows a "Customize" action.
  carton?: {
    variantKey: string;
    widthMm: number;
    heightMm: number;
    cartonNumbering: boolean;
    multipleStyles: boolean;
  } | null;
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

// One CURRENT output document + the job that produced it (its preview/decision
// endpoints are job-scoped, and the doc may come from an earlier run than the
// newest job).
export type ReviewTabCurrentFile = { jobId: string; asset: ReviewTabAsset };

// Up to 4 documents per row, per the review workflow ask.
const FILE_GRID = "grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4";

export function ReviewTab({
  styleId,
  gallery,
  owner,
  summary,
  jobs,
}: {
  styleId: string;
  // The current outputs as gallery cards (built by the page: thumbnails,
  // decisions, open comment threads).
  gallery: GalleryItem[];
  owner: { name: string; since: string | null } | null;
  summary: string;
  jobs: ReviewTabJob[];
}) {
  // The full run history, newest first — every generation is kept.
  const sortedJobs = jobs.map((j) => ({
    ...j,
    assets: [...j.assets].sort((a, b) => a.fileName.localeCompare(b.fileName)),
  }));

  return (
    <div className="flex flex-col gap-6">
      <ReviewGallery styleId={styleId} items={gallery} owner={owner} summary={summary} />

      {/* The other half of "what the supplier gets": the grid above is what
          this app generated, this is what a person had to supply by hand.
          Above the run history because it is current-state, not archive, and
          it loads its own data so the page's server render is unchanged.
          Reviewer-reachable exactly as before — its routes gate on canReview
          and this tab, like the Prod Spec tab it moved off, is open to the
          same roles. */}
      <section>
        <h2 className="text-ink text-[14px] font-semibold">Manually supplied packaging</h2>
        <p className="text-muted mb-2 text-[12px]">Packaging the buyer named on the order that this app doesn&rsquo;t generate.</p>
        <ManualTrimsPanel styleId={styleId} />
      </section>

      {/* Full run history — every generation is kept (each Re-run creates a new
          Job row). The current grid above is deduped across runs; this shows
          each run in full. Collapsed so the page doesn't grow unbounded. */}
      {sortedJobs.length > 0 && (
        <section>
          <details className="group rounded-xl border border-line bg-surface">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-ink hover:bg-subtle">
              <span className="inline-flex items-center gap-2">
                <ChevronIcon />
                All runs ({sortedJobs.length})
              </span>
              <span className="ml-2 text-xs font-normal text-muted">
                Every generation is kept in full — open to browse.
              </span>
            </summary>
            <div className="border-t border-line px-4 py-4">
              <div className="flex flex-col gap-6">
                {sortedJobs.map((job) => (
                  <div key={job.id}>
                    <div className="mb-2 flex items-baseline justify-between gap-3 text-xs text-muted">
                      <span className="inline-flex items-center gap-2">
                        <span className="font-mono">job {job.id.slice(-8)}</span> ·{" "}
                        {formatDate(job.createdAt)} ·{" "}
                        {job.triggerSource.toLowerCase().replace(/_/g, " ")}
                        {job.claimedByName ? <UserAvatar name={job.claimedByName} size="xs" /> : null}
                      </span>
                      <span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] font-medium text-ink">
                        {job.status.toLowerCase().replace(/_/g, " ")}
                      </span>
                    </div>
                    {job.assets.length === 0 ? (
                      <div className="rounded-lg border border-line bg-subtle px-4 py-3 text-xs text-muted">
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
                              displayName: asset.displayName ?? docTypeLabel(asset.docType),
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
      className="h-3.5 w-3.5 text-muted transition-transform group-open:rotate-90"
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
