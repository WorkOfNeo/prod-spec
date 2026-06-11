import { db } from "@/lib/db";
import { uploadJobAssets, type UploadResult } from "@/lib/sharepoint/upload";
import { getFile } from "@/lib/sharepoint/client";
import { dispatchEmail, type EmailOutcome } from "@/lib/email/dispatch";
import { supplierApprovalEmail } from "@/lib/email/templates/review-notification";
import { getSupplierReviewCcEmails } from "@/lib/settings/app-settings";
import { resolveNotificationsForJob } from "@/lib/notifications/user-notifications";
import { resolveRejectionTicketsFor } from "@/lib/tickets/rejection-tickets";
import { createShareForJob } from "@/lib/supplier-share/share";

// =====================================================
// "Publish" = everything that happens when a job's outputs are approved:
// SharePoint upload (when configured), status roll-ups, ticket resolution
// and the supplier email. Shared by BOTH approval paths —
//
//   POST /api/admin/jobs/[id]/approve      ("Approve all & publish")
//   per-asset roll-up                       (last output approved
//                                            individually on the review
//                                            screen)
//
// — so approving every output one by one reaches the supplier exactly
// like the bulk button. (Previously the roll-up only flipped statuses and
// publish became unreachable.)
// =====================================================

export class PublishError extends Error {
  constructor(
    public readonly httpStatus: 404 | 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export function isSharepointConfigured(): boolean {
  return Boolean(process.env.AZURE_CLIENT_ID && process.env.SHAREPOINT_SITE_ID);
}

// Recipients summary in the shape the review screen's ApprovedPanel
// already renders (kept stable for the existing UI).
export type PublishNotificationSummary = {
  to: string | null;
  cc: string | null;
  attachments: number;
  folderUrl: string | null;
  sent: boolean;
  note?: string;
};

export type PublishResult = {
  uploaded: UploadResult[];
  folderUrl: string | null;
  sharepointConfigured: boolean;
  notification: PublishNotificationSummary;
  email: EmailOutcome | null;
};

export async function publishApprovedJob(jobId: string, userId: string): Promise<PublishResult> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    include: {
      assets: true,
      style: { include: { customer: true, supplier: true, businessAreaRef: true } },
    },
  });
  if (!job) throw new PublishError(404, "Job not found");
  if (job.status !== "AWAITING_REVIEW") {
    throw new PublishError(400, `Cannot approve job in status ${job.status}`);
  }

  // Ship-gate (lives here so BOTH approval paths enforce it): placeholder
  // artifacts (dashed missing-artwork tiles, "No carton EAN configured")
  // are review-safe but must never reach print. Rejected assets are
  // excluded — their gaps are already being handled via tickets.
  const placeholderAssets = job.assets.filter(
    (a) => a.placeholderCount > 0 && a.reviewStatus !== "REJECTED",
  );
  if (placeholderAssets.length > 0) {
    throw new PublishError(
      409,
      `Approval blocked — ${placeholderAssets.length} document(s) contain placeholder artifacts ` +
        `(missing symbol/certificate artwork or missing EAN): ` +
        placeholderAssets.map((a) => a.displayName ?? a.fileName).join(", ") +
        ". Fix the data and re-run those outputs first.",
    );
  }

  // Deterministic folder layout: prodspec/<customer-slug>/<supplier-slug?>/<style-id>.
  // Once the SharePoint folder convention is finalised, parse Supplier.sharepointUrl
  // (which is the supplier's *hyperlink* in their portal, not an upload path).
  const customerSlug = job.style.customer.slug;
  const supplierSlug = job.style.supplier ? slugify(job.style.supplier.name) : null;
  const folderPath = [
    "prodspec",
    customerSlug,
    ...(supplierSlug ? [supplierSlug] : []),
    job.style.mondayItemId,
  ].join("/");

  // Upload before any status flips — a SharePoint failure must surface
  // while the job is still approvable, not strand a half-published job.
  // When SharePoint isn't configured the publish still goes ahead: the
  // supplier email carries the PDFs as attachments (from the DB), it just
  // has no folder link.
  const sharepointConfigured = isSharepointConfigured();
  const uploaded: UploadResult[] = sharepointConfigured
    ? await uploadJobAssets({
        folderPath,
        assets: job.assets.map((a) => ({
          fileName: a.fileName,
          docType: a.docType,
          pdf: Buffer.from(a.pdf),
        })),
      })
    : [];

  await db.$transaction([
    db.job.update({
      where: { id: job.id },
      data: { status: "APPROVED", finishedAt: new Date() },
    }),
    db.style.update({
      where: { id: job.styleId },
      data: { status: "APPROVED" },
    }),
    // Cascade the approval to any assets that were still pending. Assets
    // already individually decided (approved or rejected) keep their state.
    db.jobAsset.updateMany({
      where: { jobId: job.id, reviewStatus: "PENDING_REVIEW" },
      data: {
        reviewStatus: "APPROVED",
        reviewedAt: new Date(),
        reviewedById: userId,
      },
    }),
    db.reviewAction.create({
      data: { jobId: job.id, userId, action: "APPROVED" },
    }),
    db.log.create({
      data: {
        jobId: job.id,
        level: "INFO",
        message: sharepointConfigured
          ? `approved · uploaded ${uploaded.length} files`
          : `approved · SharePoint not configured — publish continues with email attachments only`,
        payload: { uploaded },
      },
    }),
  ]);

  // The job just left AWAITING_REVIEW — stamp every user's open dashboard
  // notifications pointing at it so nobody is summoned to a settled review.
  await resolveNotificationsForJob(job.id);

  // Close the rejection-ticket threads of every output that is approved
  // after the cascade (individually rejected assets keep their tickets).
  const approvedKeys = job.assets
    .filter((a) => a.reviewStatus !== "REJECTED")
    .map((a) => a.variantKey);
  const resolvedTickets = await resolveRejectionTicketsFor(job.styleId, approvedKeys);
  if (resolvedTickets > 0) {
    await db.log.create({
      data: {
        jobId: job.id,
        level: "INFO",
        message: `resolved ${resolvedTickets} rejection ticket(s) — outputs approved`,
      },
    });
  }

  // Resolve the SharePoint *folder* link for the email. getFile issues a
  // driveItem GET at the folder path (it works for folders too and returns
  // their webUrl); fall back to the supplier's portal link, then the first
  // uploaded file's webUrl.
  let folderUrl: string | null = null;
  if (sharepointConfigured) {
    try {
      folderUrl = (await getFile(folderPath))?.webUrl ?? null;
    } catch {
      folderUrl = null;
    }
  }
  folderUrl = folderUrl ?? job.style.supplier?.sharepointUrl ?? uploaded[0]?.webUrl ?? null;

  // Recipient: the supplier's mirrored inbox (To), CC the named contact
  // person. Both come from the Monday suppliers board. When the board
  // carries no supplier email yet, fall back to SUPPLIER_NOTIFICATION_EMAIL
  // so approval still surfaces to an operator who can forward manually.
  const supplier = job.style.supplier;
  const supplierEmail = supplier?.email?.trim() || process.env.SUPPLIER_NOTIFICATION_EMAIL || null;
  // CC = the admin-typed review CC list (from /settings) plus the supplier's
  // own synced contact email if present, de-duplicated.
  const reviewCc = await getSupplierReviewCcEmails();
  const ccList = Array.from(
    new Set([...reviewCc, supplier?.contactEmail ?? ""].map((e) => e.trim()).filter(Boolean)),
  );
  const ccDisplay = ccList.length > 0 ? ccList.join(", ") : null;

  // Mint the supplier-only share link (token + 4-digit PIN). Created even
  // when no supplier email resolved, so the team can read the link + PIN off
  // the prod-spec tab and forward it manually. Gated to the resolved email
  // (the unlock form checks the typed email against this); empty when none.
  const share = await createShareForJob({
    jobId: job.id,
    styleId: job.styleId,
    email: supplierEmail ?? "",
  });
  await db.log.create({
    data: {
      jobId: job.id,
      level: "INFO",
      message: `supplier share link minted (${share.url}) — PIN ${share.pin}${supplierEmail ? "" : " · no recipient yet, forward manually from the prod-spec tab"}`,
    },
  });

  const notification: PublishNotificationSummary = {
    to: supplierEmail,
    cc: ccDisplay,
    attachments: 0,
    folderUrl,
    sent: false,
  };

  // Re-runs of any flavour overwrite previously published files — flag the
  // email as a correction so the supplier knows to discard the old set.
  const isCorrection =
    job.triggerSource === "MANUAL_RERUN" ||
    job.triggerSource === "TICKET_RERUN" ||
    job.triggerSource === "TICKET_FIX";
  const files =
    uploaded.length > 0
      ? uploaded.map((f) => ({ name: f.name, webUrl: f.webUrl as string | null }))
      : job.assets.map((a) => ({ name: a.fileName, webUrl: null }));
  const email = supplierApprovalEmail({
    supplierEmail: supplierEmail ?? "",
    styleName: job.style.name,
    styleNumber: job.style.mondayItemId,
    customerName: job.style.customer.name,
    businessArea: job.style.businessAreaRef?.name ?? job.style.businessArea ?? null,
    poNumber: job.style.poNumber,
    files,
    shareUrl: share.url,
    sharePin: share.pin,
    folderUrl,
    isCorrection,
  });
  // Attach the generated PDFs so the supplier can review them directly,
  // not only via the SharePoint link.
  const attachments = job.assets.map((a) => ({
    filename: a.fileName,
    content: Buffer.from(a.pdf),
  }));
  // Always dispatch — even with no recipient. The dispatcher records a
  // SKIPPED EmailLog row so the activity table shows "we wanted to send a
  // supplier email but had nowhere to send it", same as the review-ready
  // path. (Empty `to` → SKIPPED, never an actual send.)
  const emailOutcome = await dispatchEmail({
    type: "SUPPLIER_APPROVAL",
    to: supplierEmail ?? "",
    cc: ccList.length > 0 ? ccList : undefined,
    subject: email.subject,
    html: email.html,
    text: email.text,
    attachments,
    jobId: job.id,
    styleId: job.styleId,
  });
  notification.attachments = supplierEmail ? attachments.length : 0;
  notification.sent = emailOutcome.status === "SENT";
  if (emailOutcome.status !== "SENT") {
    notification.note = supplierEmail
      ? (emailOutcome.note ?? undefined)
      : "No supplier email resolved — set the Monday supplier email column (MONDAY_SUPPLIER_COL_EMAIL) + re-sync, or set SUPPLIER_NOTIFICATION_EMAIL.";
  }
  const verb =
    emailOutcome.status === "SENT"
      ? "sent"
      : emailOutcome.status === "SIMULATED"
        ? "SIMULATED (RESEND_EMAILS off) — would send"
        : emailOutcome.status === "FAILED"
          ? `FAILED (${emailOutcome.note ?? "Resend error"}) — would send`
          : supplierEmail
            ? "skipped — would send"
            : "skipped — no supplier recipient resolved";
  await db.log.create({
    data: {
      jobId: job.id,
      level: emailOutcome.status === "FAILED" ? "WARN" : emailOutcome.status === "SKIPPED" ? "WARN" : "INFO",
      message: `supplier review email ${verb} · To: ${supplierEmail ?? "(none)"}${ccDisplay ? ` · CC: ${ccDisplay}` : ""} · ${attachments.length} attachment(s)${folderUrl ? ` · folder: ${folderUrl}` : ""}${isCorrection ? " · correction" : ""}`,
    },
  });

  return { uploaded, folderUrl, sharepointConfigured, notification, email: emailOutcome };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}
