import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { shareCookieName, verifyShareAccess } from "@/lib/supplier-share/share";
import { UnlockForm } from "./unlock-form";
import { ShareDocuments } from "./share-documents";

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
    include: { style: { include: { customer: true, businessAreaRef: true } } },
  });
  if (!share) notFound();

  // The link always shows the style's LATEST APPROVED version of each
  // output. Pull every approved asset for the style, newest first, and keep
  // the first (newest) per variant — so a re-approved correction supersedes
  // the version a supplier saw before, on the same link.
  const approvedAssets = await db.jobAsset.findMany({
    where: { reviewStatus: "APPROVED", job: { styleId: share.styleId } },
    orderBy: { createdAt: "desc" },
    select: { id: true, variantKey: true, docType: true, displayName: true, fileName: true },
  });
  const latestByVariant = new Map<string, (typeof approvedAssets)[number]>();
  for (const a of approvedAssets) {
    const key = a.variantKey ?? `doc:${a.docType}`;
    if (!latestByVariant.has(key)) latestByVariant.set(key, a);
  }
  // fileName order for display: the 00-cover / 01-general-information
  // prefixes are designed to front the bundle.
  const documents = [...latestByVariant.values()].sort((a, b) => a.fileName.localeCompare(b.fileName));

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
              These {documents.length} document{documents.length === 1 ? "" : "s"} have been approved and
              are ready for production. Open one to view the full PDF, or download it. They will also be
              saved to your SharePoint supplier folder.
            </div>
            <ShareDocuments
              documents={documents.map((asset) => ({
                id: asset.id,
                title: asset.displayName ?? asset.docType.toLowerCase().replace(/_/g, " "),
                fileName: asset.fileName,
                src: `/api/s/${token}/asset/${asset.id}`,
              }))}
            />
          </div>
        )}

        <p className="mt-10 text-center text-xs text-zinc-400">
          This is a secure link intended only for the recipient of the approval email.
        </p>
      </div>
    </div>
  );
}
