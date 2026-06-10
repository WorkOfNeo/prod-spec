import { db } from "@/lib/db";

// =====================================================
// Rejection tickets — create/reopen on reviewer rejection, resolve on
// approval. One ticket per (style × variantKey) thread: re-rejecting the
// same output after a fix REOPENS the existing ticket (comment appended)
// instead of opening a duplicate, so the admin works one thread per
// problem on /settings/rejection-log.
//
// Tickets snapshot their display context (output name, customer, BA, PO,
// comment) because the runner deletes all JobAssets on every re-run — the
// log must stay readable after the asset it was raised against is gone.
// =====================================================

// The asset shape both reject endpoints already have in hand (asset +
// its job + style context). Kept structural so callers can pass their
// Prisma results without re-querying.
export type AssetForTicket = {
  id: string;
  jobId: string;
  variantKey: string | null;
  docType: string;
  displayName: string | null;
  fileName: string;
  job: {
    styleId: string;
    style: {
      name: string;
      mondayItemId: string;
      poNumber: string | null;
      businessArea: string | null;
      customer: { name: string };
      businessAreaRef: { name: string } | null;
    };
  };
};

const REOPEN_STAMP = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function docTypeLabel(docType: string): string {
  return docType.toLowerCase().replace(/_/g, " ");
}

export async function createOrReopenRejectionTicket(input: {
  asset: AssetForTicket;
  comment: string;
  reportedById: string;
}): Promise<{ ticketId: string; reopened: boolean }> {
  const { asset } = input;
  const style = asset.job.style;
  // "" for legacy assets that predate per-variant keys — ticket re-runs
  // then regenerate the full job instead of a single output.
  const variantKey = asset.variantKey ?? "";

  const existing = await db.rejectionTicket.findFirst({
    where: { styleId: asset.job.styleId, variantKey, status: { not: "RESOLVED" } },
    orderBy: { createdAt: "desc" },
    select: { id: true, comment: true, reopenedCount: true, status: true },
  });

  if (existing) {
    // Same thread, new complaint. Only count it as a REOPEN when the
    // ticket had already been through a fix (FIXED) — piling a second
    // comment onto a still-open ticket is just more detail.
    const reopened = existing.status === "FIXED";
    await db.rejectionTicket.update({
      where: { id: existing.id },
      data: {
        status: "OPEN",
        comment: `${existing.comment}\n\n— re-rejected ${REOPEN_STAMP.format(new Date())} —\n${input.comment}`,
        reopenedCount: reopened ? existing.reopenedCount + 1 : existing.reopenedCount,
        fixedAt: null,
        resolvedAt: null,
        jobId: asset.jobId,
        jobAssetId: asset.id,
        fileName: asset.fileName,
        outputName: asset.displayName ?? docTypeLabel(asset.docType),
      },
    });
    return { ticketId: existing.id, reopened };
  }

  const ticket = await db.rejectionTicket.create({
    data: {
      styleId: asset.job.styleId,
      jobId: asset.jobId,
      jobAssetId: asset.id,
      variantKey,
      docType: asset.docType,
      outputName: asset.displayName ?? docTypeLabel(asset.docType),
      fileName: asset.fileName,
      customerName: style.customer.name,
      businessArea: style.businessAreaRef?.name ?? style.businessArea ?? null,
      poNumber: style.poNumber,
      styleName: style.name,
      styleNumber: style.mondayItemId,
      comment: input.comment,
      reportedById: input.reportedById,
    },
    select: { id: true },
  });
  return { ticketId: ticket.id, reopened: false };
}

// Approving an output closes its ticket thread. Called from the per-asset
// approve endpoint and from publishApprovedJob (job-level approve cascades
// every still-pending asset). Returns how many tickets were resolved.
export async function resolveRejectionTicketsFor(
  styleId: string,
  variantKeys: Array<string | null>,
): Promise<number> {
  const keys = variantKeys.map((k) => k ?? "");
  if (keys.length === 0) return 0;
  const res = await db.rejectionTicket.updateMany({
    where: { styleId, variantKey: { in: keys }, status: { not: "RESOLVED" } },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
  return res.count;
}
