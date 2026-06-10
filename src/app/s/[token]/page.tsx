import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { shareCookieName, verifyShareAccess } from "@/lib/supplier-share/share";
import { UnlockForm } from "./unlock-form";

export const dynamic = "force-dynamic";

// Supplier-facing approved-PDF viewer. Public route (outside the admin
// matcher in src/proxy.ts). The token in the URL is the primary gate; the
// supplier additionally enters email + PIN to unlock. Once unlocked (cookie
// set by /api/s/[token]/unlock) the approved PDFs render inline.
export default async function SupplierSharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const share = await db.supplierShare.findUnique({
    where: { token },
    include: {
      style: { include: { customer: true, businessAreaRef: true } },
      job: {
        include: {
          assets: {
            where: { reviewStatus: "APPROVED" },
            orderBy: { createdAt: "asc" },
            select: { id: true, displayName: true, docType: true, fileName: true },
          },
        },
      },
    },
  });
  if (!share) notFound();

  const cookieStore = await cookies();
  const unlocked = verifyShareAccess(token, cookieStore.get(shareCookieName(token))?.value);

  const businessArea = share.style.businessAreaRef?.name ?? share.style.businessArea ?? null;

  return (
    <div className="min-h-full bg-zinc-50">
      <div className="mx-auto max-w-3xl px-5 py-10">
        <div className="mb-6">
          <div className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Prod Spec</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">
            {share.style.name}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {share.style.customer.name}
            {businessArea ? <> · {businessArea}</> : null}
            {share.style.poNumber ? <> · PO {share.style.poNumber}</> : null}
          </p>
        </div>

        {!unlocked ? (
          <UnlockForm token={token} />
        ) : (
          <div>
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              These {share.job.assets.length} document{share.job.assets.length === 1 ? "" : "s"} have been
              approved and are ready for production. They will also be saved to your SharePoint supplier
              folder.
            </div>
            {share.job.assets.length === 0 ? (
              <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-400">
                No approved documents on this link.
              </p>
            ) : (
              <div className="space-y-5">
                {share.job.assets.map((asset) => {
                  const src = `/api/s/${token}/asset/${asset.id}`;
                  const title = asset.displayName ?? asset.docType.toLowerCase().replace(/_/g, " ");
                  return (
                    <div key={asset.id} className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
                      <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-2.5">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-zinc-800">{title}</div>
                          <div className="truncate font-mono text-[10px] text-zinc-400">{asset.fileName}</div>
                        </div>
                        <a
                          href={src}
                          download={asset.fileName}
                          className="shrink-0 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800"
                        >
                          Download
                        </a>
                      </div>
                      <iframe src={src} title={title} className="block h-[560px] w-full bg-white" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <p className="mt-10 text-center text-xs text-zinc-400">
          This is a secure link intended only for the recipient of the approval email.
        </p>
      </div>
    </div>
  );
}
