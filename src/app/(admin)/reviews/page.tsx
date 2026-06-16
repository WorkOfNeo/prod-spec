import { redirect } from "next/navigation";
import { getSessionWithRole } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { loadDocTypeLabels } from "@/lib/pdf/doc-types-db";
import { timeAgo } from "@/lib/time";
import { ReviewsList, type ReviewRow } from "./reviews-list";

export const dynamic = "force-dynamic";

// All outputs, newest first (T8). Read-only over JobAsset joined to its Job /
// Style / Customer. Visible to reviewers and admins alike — it sits under
// "My tasks" in the sidebar — so it gates on a session, not the admin role.
//
// Cap the scan: the table is a browsing surface, not an export. The client
// filter narrows within the most recent slice; if the history grows past the
// cap the page says so rather than silently implying it showed everything.
const MAX_ROWS = 500;

// COVER / GENERAL_INFO framing pages aren't catalogue doc types, so they have
// no label row — fall back to a humanised version of the raw value.
function humaniseDocType(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export default async function ReviewsPage() {
  const { session } = await getSessionWithRole();
  if (!session) redirect("/login");

  const [assets, docTypeLabels] = await Promise.all([
    db.jobAsset.findMany({
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: {
        id: true,
        jobId: true,
        docType: true,
        displayName: true,
        fileName: true,
        variantKey: true,
        reviewStatus: true,
        createdAt: true,
        job: {
          select: {
            styleId: true,
            style: {
              select: {
                name: true,
                businessArea: true,
                customer: { select: { name: true } },
                businessAreaRef: { select: { name: true } },
              },
            },
          },
        },
      },
    }),
    loadDocTypeLabels(),
  ]);

  const rows: ReviewRow[] = assets.map((a) => {
    // Prefer variantKey — uniquely identifies the asset when several variants
    // on one job share a docType; fall back to docType for legacy assets.
    const previewQuery = a.variantKey
      ? `variantKey=${encodeURIComponent(a.variantKey)}`
      : `docType=${encodeURIComponent(a.docType)}`;
    return {
      id: a.id,
      outputType: docTypeLabels[a.docType] ?? humaniseDocType(a.docType),
      outputName: a.displayName ?? a.fileName,
      styleId: a.job.styleId,
      styleName: a.job.style.name,
      customerName: a.job.style.customer.name,
      businessArea: a.job.style.businessAreaRef?.name ?? a.job.style.businessArea ?? null,
      reviewStatus: a.reviewStatus,
      openHref: `/api/admin/jobs/${a.jobId}/preview?${previewQuery}`,
      createdAgo: timeAgo(a.createdAt),
    };
  });

  return <ReviewsList rows={rows} truncated={assets.length === MAX_ROWS} />;
}
