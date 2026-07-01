import { db } from "@/lib/db";
import { isOrphanedOutputKey } from "./orphan";

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

// A decoded image the reviewer attached to the rejection comment. Bytes are
// already validated/decoded by the reject route (see lib/images/decode-data-url).
export type RejectionAttachmentInput = {
  data: Buffer<ArrayBuffer>;
  mimeType: string;
  fileName: string;
  byteSize: number;
};

export async function createOrReopenRejectionTicket(input: {
  asset: AssetForTicket;
  comment: string;
  reportedById: string;
  attachments?: RejectionAttachmentInput[];
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

  let ticketId: string;
  let reopened: boolean;
  if (existing) {
    // Same thread, new complaint. Only count it as a REOPEN when the
    // ticket had already been through a fix (FIXED) — piling a second
    // comment onto a still-open ticket is just more detail.
    reopened = existing.status === "FIXED";
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
    ticketId = existing.id;
  } else {
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
    ticketId = ticket.id;
    reopened = false;
  }

  // Persist any images the reviewer attached, against this ticket thread.
  // Best-effort: a missing rejection_attachments table (the window before
  // db:deploy runs) must never block the rejection itself — the comment is the
  // record that matters; a dropped image is logged, not fatal.
  if (input.attachments?.length) {
    try {
      await db.rejectionAttachment.createMany({
        data: input.attachments.map((a) => ({
          ticketId,
          data: a.data,
          mimeType: a.mimeType,
          fileName: a.fileName,
          byteSize: a.byteSize,
          uploadedById: input.reportedById,
        })),
      });
    } catch (err) {
      await db.log
        .create({
          data: {
            jobId: asset.jobId,
            level: "WARN",
            message: `rejection attachment save skipped: ${(err as Error).message}`,
          },
        })
        .catch(() => {});
    }
  }

  return { ticketId, reopened };
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

// Fresh-round supersede: a FULL re-run regenerates the whole style, so it
// opens a brand-new review round — every prior still-open ticket is stale and
// moves to history (RESOLVED). Returns the Prisma op UN-awaited so the runner
// can embed it in its settle transaction (atomic with the asset swap: the log
// never shows fresh outputs alongside a lingering "rejected" badge). Clears
// ALL of the style's open threads regardless of variant — including outputs
// that couldn't regenerate this round (excluded by a doc-type rule, or missing
// data), which is exactly what keeps an excluded output from pinning the style
// to the active log forever. A later re-rejection opens a fresh ticket. Only
// FULL rounds call this; scoped/partial re-runs touch only what they targeted.
export function supersedeOpenTicketsForStyleOp(styleId: string) {
  return db.rejectionTicket.updateMany({
    where: { styleId, status: { not: "RESOLVED" } },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
}

// Output-change cleanup: when a ProdSpec's outputs are edited, any still-open
// ticket whose output was REMOVED (its base key is no longer declared) is
// orphaned — re-running it could only NO_OUTPUTS-fail (see lib/tickets/orphan.ts).
// Resolve those in place across every style on the spec. Framing / legacy-empty
// keys are never touched. Best-effort by design — the PATCH route wraps this so
// a cleanup miss never blocks the save. Returns the count resolved.
export async function resolveTicketsForRemovedOutputs(
  prodSpecId: string,
  currentBaseKeys: Set<string>,
): Promise<number> {
  const open = await db.rejectionTicket.findMany({
    where: { style: { prodSpecId }, status: { not: "RESOLVED" } },
    select: { id: true, variantKey: true },
  });
  const orphanIds = open
    .filter((t) => isOrphanedOutputKey(t.variantKey, currentBaseKeys))
    .map((t) => t.id);
  if (orphanIds.length === 0) return 0;
  const res = await db.rejectionTicket.updateMany({
    where: { id: { in: orphanIds } },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
  return res.count;
}
