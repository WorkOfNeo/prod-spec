import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { AssetActions } from "./asset-actions";
import { OutputBulkActions } from "./output-bulk-actions";
import { ReviewClaim } from "./claim-review";
import { ReviewLeaveGuard } from "./leave-guard";
import { groupByDocType, DocTypeAccordion } from "../doc-type-groups";
import { loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { reviewFollowThroughEnabled } from "@/lib/review-flow/flags";
import {
  getCurrentOutputsForStyle,
  rollupOutputs,
  outputAnchor,
  type CurrentOutput,
  type OutputState,
} from "@/lib/outputs/current-outputs";

export const dynamic = "force-dynamic";

// The review screen now reads the STYLE's current outputs — the latest asset
// per (variantKey) across all jobs, lined up against the declared output set —
// so outputs generated in different runs roll up here together. Decisions stay
// per output; the bulk shortcuts loop the per-output endpoints.

const NOT_READY_LABEL: Record<OutputState, string> = {
  AWAITING_DATA: "Awaiting data",
  READY_TO_GENERATE: "Ready to generate",
  GENERATING: "Generating…",
  TO_REVIEW: "To review",
  BLOCKED: "Blocked",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession();

  const style = await db.style.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      poNumber: true,
      businessArea: true,
      customer: { select: { name: true } },
      businessAreaRef: { select: { name: true } },
    },
  });
  if (!style) notFound();

  const [outputs, docTypeLabels] = await Promise.all([
    getCurrentOutputsForStyle(id),
    loadDocTypeLabels(),
  ]);
  const rollup = rollupOutputs(outputs);

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
  const notReady = outputs.filter((o) => o.jobAssetId == null || o.state === "GENERATING");
  const pendingReviewable = reviewable.filter((o) => o.reviewStatus === "PENDING_REVIEW");
  const approveAssetIds = pendingReviewable
    .filter((o) => o.placeholderCount === 0 && o.jobAssetId)
    .map((o) => o.jobAssetId as string);
  const rejectAssetIds = pendingReviewable.map((o) => o.jobAssetId as string);
  const blockedCount = pendingReviewable.filter((o) => o.placeholderCount > 0).length;

  const notGeneratedCount = rollup.awaitingData + rollup.readyToGenerate;
  const tally = [
    rollup.approved > 0 ? `${rollup.approved} approved` : null,
    rollup.rejected > 0 ? `${rollup.rejected} rejected` : null,
    rollup.toReview > 0 ? `${rollup.toReview} to review` : null,
    rollup.blocked > 0 ? `${rollup.blocked} blocked` : null,
    rollup.generating > 0 ? `${rollup.generating} generating` : null,
    notGeneratedCount > 0 ? `${notGeneratedCount} not generated` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Test-phase follow-through (claim popup/chip + leave guard) — bound to the
  // newest still-pending generation job for this style, with style-level counts.
  const followThrough = reviewFollowThroughEnabled();
  const pendingJob = followThrough
    ? await db.job.findFirst({
        where: { styleId: id, status: "AWAITING_REVIEW" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          reviewClaimedById: true,
          reviewClaimedAt: true,
          reviewClaimedBy: { select: { name: true, email: true } },
        },
      })
    : null;
  const decided = reviewable.filter(
    (o) => o.reviewStatus === "APPROVED" || o.reviewStatus === "REJECTED",
  ).length;
  const pending = pendingReviewable.length;
  const claimedByMe =
    pendingJob?.reviewClaimedById != null && pendingJob.reviewClaimedById === session?.user.id;

  if (outputs.length === 0) {
    return (
      <div className="px-8 py-8">
        <Link href={`/styles/${id}`} className="text-xs text-zinc-500 underline">← Back</Link>
        <h1 className="mt-2 text-2xl font-semibold">No outputs to review</h1>
        <p className="mt-1 text-sm text-zinc-500">
          This style has no enabled outputs on its prod spec yet.
        </p>
      </div>
    );
  }

  const groups = groupByDocType<CurrentOutput>(reviewable, docTypeLabels);
  const placeholderOutputs = reviewable.filter((o) => o.placeholderCount > 0);

  return (
    <div className="px-8 py-8">
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
      <Link href={`/styles/${id}`} className="text-xs text-zinc-500 underline">← Back to style</Link>
      <div className="mt-2 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review · {style.name}</h1>
          <p className="text-sm text-zinc-500">
            {style.customer.name}
            {businessArea ? <> · {businessArea}</> : null}
            {style.poNumber ? <> · PO {style.poNumber}</> : null}
            {" · "}
            {rollup.total} output{rollup.total === 1 ? "" : "s"}
            {tally ? <> — {tally}</> : null}
          </p>
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
        </div>
        <OutputBulkActions
          styleId={style.id}
          styleContext={styleContext}
          approveAssetIds={approveAssetIds}
          rejectAssetIds={rejectAssetIds}
          blockedCount={blockedCount}
        />
      </div>

      {placeholderOutputs.length > 0 && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="text-sm font-semibold text-red-800">
            {placeholderOutputs.length} output
            {placeholderOutputs.length > 1 ? "s contain" : " contains"} placeholder artifacts —
            approval is blocked
          </div>
          <p className="mt-1 text-xs text-red-700">
            Dashed “missing artwork” tiles or “No carton EAN” boxes are review-safe but must never
            ship to print. Fix the gaps and re-run the output.
          </p>
          <ul className="mt-2 space-y-0.5 text-xs text-red-800">
            {placeholderOutputs.map((o) => (
              <li key={o.variantKey}>
                · {o.name} — {o.placeholderCount} placeholder{o.placeholderCount > 1 ? "s" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Generated outputs, grouped per document type. */}
      <div className="mt-6 flex flex-col gap-3">
        {groups.map((group) => {
          const gApproved = group.items.filter((o) => o.reviewStatus === "APPROVED").length;
          const gRejected = group.items.filter((o) => o.reviewStatus === "REJECTED").length;
          const gPending = group.items.length - gApproved - gRejected;
          const hint = [
            gApproved > 0 ? `${gApproved} approved` : null,
            gRejected > 0 ? `${gRejected} rejected` : null,
            gPending > 0 ? `${gPending} pending` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <DocTypeAccordion
              key={group.docType}
              label={group.label}
              count={group.items.length}
              rightHint={hint}
            >
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {group.items.map((o) => {
                  const previewUrl = `/api/admin/jobs/${o.jobId}/preview?variantKey=${encodeURIComponent(o.variantKey)}`;
                  return (
                    <div
                      key={o.variantKey}
                      id={outputAnchor(o.variantKey)}
                      className="overflow-hidden rounded-lg border border-zinc-200 bg-white scroll-mt-4"
                    >
                      <div className="flex items-center justify-between gap-3 border-b border-zinc-100 bg-zinc-50 px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-zinc-800">{o.name}</div>
                          {o.fileName ? (
                            <div className="truncate font-mono text-[10px] text-zinc-500">{o.fileName}</div>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <a
                            href={previewUrl}
                            className="text-xs text-zinc-500 underline"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Open
                          </a>
                          <AssetActions
                            assetId={o.jobAssetId as string}
                            styleId={style.id}
                            reviewStatus={o.reviewStatus ?? "PENDING_REVIEW"}
                            rejectReason={o.rejectReason}
                            placeholderCount={o.placeholderCount}
                            outputTitle={o.name}
                            styleContext={styleContext}
                          />
                        </div>
                      </div>
                      {o.reviewStatus === "REJECTED" && o.rejectReason ? (
                        <div className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-800">
                          <span className="font-semibold">Rejected:</span> {o.rejectReason}{" "}
                          <Link href="/settings/rejection-log" className="text-red-700 underline">
                            view ticket →
                          </Link>
                        </div>
                      ) : null}
                      {o.placeholderCount > 0 ? (
                        <div className="border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          ⚠ {o.placeholderCount} placeholder{o.placeholderCount === 1 ? "" : "s"} in this
                          PDF — approval is blocked until the data is fixed and the output re-run.
                        </div>
                      ) : null}
                      <iframe src={previewUrl} className="block h-[600px] w-full bg-white" title={o.name} />
                    </div>
                  );
                })}
              </div>
            </DocTypeAccordion>
          );
        })}
      </div>

      {notReady.length > 0 ? (
        <div className="mt-3">
          <DocTypeAccordion
            label="Not generated yet"
            count={notReady.length}
            rightHint="awaiting data, queued, or generating"
            defaultOpen={false}
          >
            <ul className="divide-y divide-zinc-100 text-sm">
              {notReady.map((o) => (
                <li key={o.variantKey} className="flex items-center justify-between gap-3 py-2">
                  <span className="font-medium text-zinc-700">{o.name}</span>
                  <span className="flex items-center gap-2 text-xs text-zinc-500">
                    {o.state === "AWAITING_DATA" && o.missing.length > 0 ? (
                      <span className="text-amber-700">
                        missing: {o.missing.map((m) => m.label).join(", ")}
                      </span>
                    ) : null}
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-600">
                      {NOT_READY_LABEL[o.state]}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </DocTypeAccordion>
        </div>
      ) : null}
    </div>
  );
}
