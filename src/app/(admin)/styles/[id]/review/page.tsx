import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { ReviewActions } from "./review-actions";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const style = await db.style.findUnique({
    where: { id },
    include: {
      customer: true,
      jobs: {
        where: { status: "AWAITING_REVIEW" },
        include: { assets: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!style) notFound();

  const sharepointConfigured = Boolean(process.env.AZURE_CLIENT_ID && process.env.SHAREPOINT_SITE_ID);
  const job = style.jobs[0];
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

  return (
    <div className="px-8 py-8">
      <Link href={`/styles/${id}`} className="text-xs text-zinc-500 underline">← Back to style</Link>
      <div className="mt-2 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review · {style.name}</h1>
          <p className="text-sm text-zinc-500">
            {style.customer.name} · {job.assets.length} documents
          </p>
        </div>
        <ReviewActions jobId={job.id} styleId={style.id} sharepointConfigured={sharepointConfigured} />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4">
        {job.assets.map((asset) => (
          <div key={asset.id} className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
            <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-600">
                {asset.docType.toLowerCase().replace(/_/g, " ")}
              </span>
              <a
                href={`/api/admin/jobs/${job.id}/preview?docType=${asset.docType}`}
                className="text-xs text-zinc-500 underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open
              </a>
            </div>
            <iframe
              src={`/api/admin/jobs/${job.id}/preview?docType=${asset.docType}`}
              className="block h-[600px] w-full bg-white"
              title={asset.docType}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
