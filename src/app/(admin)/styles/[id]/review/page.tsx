import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { ReviewActions } from "./review-actions";
import { AssetActions } from "./asset-actions";
import { isSharepointConfigured } from "@/lib/publish/publish-approved-job";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const style = await db.style.findUnique({
    where: { id },
    include: {
      customer: true,
      businessAreaRef: true,
      jobs: {
        where: { status: "AWAITING_REVIEW" },
        include: { assets: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!style) notFound();

  const job = style.jobs[0];
  const placeholderAssets = job?.assets.filter((a) => a.placeholderCount > 0) ?? [];
  if (!job) {
    return (
      <div className="px-8 py-8">
        <Link href={`/styles/${id}`} className="text-xs text-zinc-500 underline">← Back</Link>
        <h1 className="mt-2 text-2xl font-semibold">No documents awaiting review</h1>
        <p className="mt-1 text-sm text-zinc-500">
          This style does not have a job awaiting review. Re-run from the detail page if needed.
        </p>
      </div>
    );
  }

  const businessArea = style.businessAreaRef?.name ?? style.businessArea ?? null;
  const styleContext = [
    style.name,
    style.customer.name,
    businessArea,
    style.poNumber ? `PO ${style.poNumber}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const approved = job.assets.filter((a) => a.reviewStatus === "APPROVED").length;
  const rejected = job.assets.filter((a) => a.reviewStatus === "REJECTED").length;
  const pendingCount = job.assets.length - approved - rejected;
  const decidedSummary = [
    approved > 0 ? `${approved} approved` : null,
    rejected > 0 ? `${rejected} rejected` : null,
    pendingCount > 0 ? `${pendingCount} pending` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="px-8 py-8">
      <Link href={`/styles/${id}`} className="text-xs text-zinc-500 underline">← Back to style</Link>
      <div className="mt-2 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review · {style.name}</h1>
          <p className="text-sm text-zinc-500">
            {style.customer.name}
            {businessArea ? <> · {businessArea}</> : null}
            {style.poNumber ? <> · PO {style.poNumber}</> : null}
            {" · "}
            {job.assets.length} documents{decidedSummary ? <> — {decidedSummary}</> : null}
          </p>
        </div>
        <ReviewActions
          jobId={job.id}
          styleId={style.id}
          styleContext={styleContext}
          sharepointConfigured={isSharepointConfigured()}
        />
      </div>

      {placeholderAssets.length > 0 && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="text-sm font-semibold text-red-800">
            {placeholderAssets.length} document{placeholderAssets.length > 1 ? "s contain" : " contains"}{" "}
            placeholder artifacts — approval is blocked
          </div>
          <p className="mt-1 text-xs text-red-700">
            Dashed &ldquo;missing artwork&rdquo; tiles or &ldquo;No carton EAN&rdquo; boxes are
            review-safe but must never ship to print. Fix the gaps (symbol artwork at
            /settings/washcare-symbols, certificate logos, EAN resolution) and re-run the output.
          </p>
          <ul className="mt-2 space-y-0.5 text-xs text-red-800">
            {placeholderAssets.map((a) => (
              <li key={a.id}>
                · {a.displayName ?? a.fileName} — {a.placeholderCount} placeholder
                {a.placeholderCount > 1 ? "s" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-4">
        {job.assets.map((asset) => {
          // Prefer variantKey — uniquely identifies the asset when multiple
          // variants on the same job share a docType. Fall back to docType
          // for legacy assets whose variantKey wasn't recorded.
          const previewQuery = asset.variantKey
            ? `variantKey=${encodeURIComponent(asset.variantKey)}`
            : `docType=${asset.docType}`;
          const title = asset.displayName ?? asset.docType.toLowerCase().replace(/_/g, " ");
          return (
            <div key={asset.id} className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
              <div className="flex items-center justify-between gap-3 border-b border-zinc-100 bg-zinc-50 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-800">{title}</div>
                  <div className="truncate font-mono text-[10px] text-zinc-500">{asset.fileName}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <a
                    href={`/api/admin/jobs/${job.id}/preview?${previewQuery}`}
                    className="text-xs text-zinc-500 underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open
                  </a>
                  <AssetActions
                    assetId={asset.id}
                    styleId={style.id}
                    reviewStatus={asset.reviewStatus}
                    rejectReason={asset.rejectReason}
                    placeholderCount={asset.placeholderCount}
                    outputTitle={title}
                    styleContext={styleContext}
                  />
                </div>
              </div>
              {asset.reviewStatus === "REJECTED" && asset.rejectReason ? (
                <div className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-800">
                  <span className="font-semibold">Rejected:</span> {asset.rejectReason}{" "}
                  <Link href="/settings/rejection-log" className="text-red-700 underline">
                    view ticket →
                  </Link>
                </div>
              ) : null}
              {asset.placeholderCount > 0 ? (
                <div className="border-b border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  ⚠ {asset.placeholderCount} placeholder{asset.placeholderCount === 1 ? "" : "s"} in this
                  PDF — approval is blocked until the data is fixed and the output re-run.
                </div>
              ) : null}
              <iframe
                src={`/api/admin/jobs/${job.id}/preview?${previewQuery}`}
                className="block h-[600px] w-full bg-white"
                title={title}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
