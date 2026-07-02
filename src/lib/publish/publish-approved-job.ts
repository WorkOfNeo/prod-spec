import { db } from "@/lib/db";
import { uploadJobAssets, type UploadResult } from "@/lib/sharepoint/upload";
import { getFile } from "@/lib/sharepoint/client";
import { dispatchEmail, type EmailOutcome } from "@/lib/email/dispatch";
import { enqueueApprovedAssetsForJob } from "@/lib/publish/supplier-send-queue";
import { pushQueuedSupplierUploads } from "@/lib/sharepoint/push-queued-to-supplier";
import { customerApprovalEmail } from "@/lib/email/templates/review-notification";
import { getSupplierReviewCcEmails } from "@/lib/settings/app-settings";
import { resolveNotificationsForJob } from "@/lib/notifications/user-notifications";
import { resolveRejectionTicketsFor } from "@/lib/tickets/rejection-tickets";
import { ignoreBaseKey, loadIgnoredOutputKeys } from "@/lib/outputs/output-ignores";
import { upsertShareForStyle } from "@/lib/supplier-share/share";
import { combineSupplierRecipients } from "@/lib/suppliers/recipients";
import { loadContactEmailsBySupplier } from "@/lib/suppliers/contact-emails";
import { parseCustomerConfig } from "@/lib/customers/config";
import { resolveStyleCertificates } from "@/lib/styles/resolved-fields";
import { applyStyleApprovalToMonday } from "@/lib/monday/style-approval";

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
    // reviewEndedAt is WRITTEN here (best-effort, separately) but never read —
    // omit it so the settle flow keeps working before the additive Track-A
    // column is deployed (db:deploy). See stampReviewEnded below.
    omit: { reviewEndedAt: true },
    include: {
      assets: true,
      style: { include: { customer: true, supplier: true, businessAreaRef: true } },
    },
  });
  if (!job) throw new PublishError(404, "Job not found");
  if (job.status !== "AWAITING_REVIEW") {
    throw new PublishError(400, `Cannot approve job in status ${job.status}`);
  }

  // Outputs the operator ignored for this style are dropped from EVERYTHING a
  // publish does externally: the SharePoint upload, the approval cascade, the
  // supplier-send queue and the email file list. `publishable` is the asset
  // set every step below works from.
  const ignoredKeys = await loadIgnoredOutputKeys(job.styleId);
  const isIgnoredAsset = (a: { variantKey: string | null; docType: string }) =>
    ignoredKeys.has(ignoreBaseKey(a.variantKey, a.docType));
  const publishable = job.assets.filter((a) => !isIgnoredAsset(a));

  // Ship-gate (lives here so BOTH approval paths enforce it): placeholder
  // artifacts (dashed missing-artwork tiles, "No carton EAN configured")
  // are review-safe but must never reach print. Rejected assets are
  // excluded — their gaps are already being handled via tickets.
  const placeholderAssets = publishable.filter(
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
        assets: publishable.map((a) => ({
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
    // already individually decided (approved or rejected) keep their state;
    // ignored outputs' assets stay PENDING — approving them would re-arm the
    // supplier-send queue for an output that must never ship.
    db.jobAsset.updateMany({
      where: {
        jobId: job.id,
        reviewStatus: "PENDING_REVIEW",
        id: { in: publishable.map((a) => a.id) },
      },
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
  const approvedKeys = publishable
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

  // Customer config drives delivery: when the customer delivers their own
  // goods (config.skipSupplierDelivery, e.g. Woolworth) we skip ALL external
  // delivery — the supplier email + share link here, and the Monday subitem
  // flip + customer-responsible email in onStyleFullyApproved. Internal
  // approval and per-PDF approved state are unaffected.
  const skipDelivery = parseCustomerConfig(job.style.customer.config).skipSupplierDelivery;
  // Certificates the supplier must apply (T10) — resolved from the style's
  // declared certifications; listed in the supplier email and echoed to the
  // customer-responsible notice.
  const requiredCerts = resolveStyleCertificates(job.style);

  // Re-runs of any flavour overwrite previously published files — flag the
  // email as a correction so the supplier knows to discard the old set.
  const isCorrection =
    job.triggerSource === "MANUAL_RERUN" ||
    job.triggerSource === "TICKET_RERUN" ||
    job.triggerSource === "TICKET_FIX";
  const files =
    uploaded.length > 0
      ? uploaded.map((f) => ({ name: f.name, webUrl: f.webUrl as string | null }))
      : publishable.map((a) => ({ name: a.fileName, webUrl: null }));

  // Recipient: the supplier's mirrored inbox (To), then the synced contacts
  // from the Supplier Contacts board, then the legacy contactEmail — shared
  // resolution in combineSupplierRecipients. When nothing resolves, fall back
  // to SUPPLIER_NOTIFICATION_EMAIL so approval still surfaces to an operator
  // who can forward manually.
  const supplier = job.style.supplier;
  const supplierContactEmails = supplier
    ? ((await loadContactEmailsBySupplier([supplier.id])).get(supplier.id) ?? [])
    : [];
  const supplierRecipients = combineSupplierRecipients(supplier, supplierContactEmails);
  const supplierEmail =
    supplierRecipients.to || process.env.SUPPLIER_NOTIFICATION_EMAIL || null;

  const notification: PublishNotificationSummary = {
    to: null,
    cc: null,
    attachments: 0,
    folderUrl,
    sent: false,
  };
  const emailOutcome: EmailOutcome | null = null;

  if (skipDelivery) {
    // Customer delivers own — no supplier email, no share link created.
    notification.note =
      "Customer delivers own goods — supplier delivery skipped (config.skipSupplierDelivery).";
    await db.log.create({
      data: {
        jobId: job.id,
        level: "INFO",
        message:
          "supplier delivery skipped — customer delivers own (skipSupplierDelivery): no supplier email, no share link",
      },
    });
  } else {
    // CC = the admin-typed review CC list (from /settings) plus the supplier's
    // synced contact emails, de-duplicated.
    const reviewCc = await getSupplierReviewCcEmails();
    const ccList = Array.from(
      new Set([...reviewCc, ...supplierRecipients.cc].map((e) => e.trim()).filter(Boolean)),
    );
    const ccDisplay = ccList.length > 0 ? ccList.join(", ") : null;

    // The supplier-only share link (one durable link per style: stable token
    // + 4-digit PIN). Refreshed on every approval — the portal always serves
    // the style's LATEST APPROVED version, so a correction pushes through to
    // this same link. Created even when no supplier email resolved, so the
    // team can read the link + PIN off the prod-spec tab and forward it.
    const share = await upsertShareForStyle({
      styleId: job.styleId,
      email: supplierEmail ?? "",
    });
    await db.log.create({
      data: {
        jobId: job.id,
        level: "INFO",
        message: `supplier share link ${share.url} — PIN ${share.pin}${supplierEmail ? "" : " · no recipient yet, forward manually from the prod-spec tab"}`,
      },
    });

    notification.to = supplierEmail;
    notification.cc = ccDisplay;

    // Supplier email is DEFERRED to the nightly batch (WS2). Per-approval
    // emails were the OLD mechanism — one email per approval. Now approving an
    // output only (a) uploads to SharePoint (above), (b) refreshes the durable
    // share link (above), and (c) queues the output (enqueue below). The
    // midnight cron then sends ONE digest per supplier covering everything
    // queued for them. So we do NOT dispatch a supplier email here;
    // `emailOutcome` stays null and the review screen shows "queued", not
    // "sent". Reference the still-relevant bits so they read as intentional.
    void files;
    void requiredCerts;
    void isCorrection;
    notification.note = supplierEmail
      ? "Queued for the nightly supplier batch — the supplier is emailed once at midnight, not per approval."
      : "No supplier email on file — output still queued; set the Monday supplier email + re-sync before the nightly send.";
    await db.log.create({
      data: {
        jobId: job.id,
        level: "INFO",
        message: `supplier email deferred to nightly batch (output queued) · To: ${supplierEmail ?? "(none)"}${ccDisplay ? ` · CC: ${ccDisplay}` : ""}${folderUrl ? ` · folder: ${folderUrl}` : ""}`,
      },
    });
  }

  // Mark the review's end the moment the job leaves AWAITING_REVIEW. Best-
  // effort: reviewEndedAt is an additive Track-A column that may not be
  // deployed yet — never fail a publish over reporting metadata.
  await stampReviewEnded(job.id);

  // Style-level chain reaction: once EVERY output for the whole style is
  // approved, flip the Monday subitems (01e/01f) and email the customer-
  // responsible person. Skipped wholesale for skipSupplierDelivery customers.
  // Never throws — a Monday/email hiccup must not unwind a published job.
  await onStyleFullyApproved({
    styleId: job.styleId,
    jobId: job.id,
    styleNumber: job.style.name,
    customerName: job.style.customer.name,
    businessArea: job.style.businessAreaRef?.name ?? job.style.businessArea ?? null,
    poNumber: job.style.poNumber,
    files,
    requiredCerts,
    supplierEmail: skipDelivery ? null : supplierEmail,
    skipExternal: skipDelivery,
  });

  // Capture every approved output of this job into the supplier-send queue
  // (WS2) — additive to the existing publish above, fail-soft, and independent
  // of whether batch sending is enabled. The queue is what /settings/approved
  // reads; the midnight cron (WS2b) is what actually sends from it.
  try {
    await enqueueApprovedAssetsForJob(job.id);
  } catch (err) {
    console.warn(`[supplier-send-queue] job enqueue failed for ${job.id}:`, err);
  }

  // Push the just-queued outputs into the supplier's OWN SharePoint folder
  // (Supplier.sharepointUrl → "<style> – <customer>") so the files are in
  // place before the nightly digest references them. Fail-soft and flag-gated
  // inside the lib — a folder hiccup surfaces on /settings/approved (FAILED,
  // retried by the midnight sweep), never unwinds the publish.
  if (!skipDelivery) {
    try {
      await pushQueuedSupplierUploads({ styleIds: [job.styleId] });
    } catch (err) {
      console.warn(`[supplier-upload] publish push failed for ${job.id}:`, err);
    }
  }

  return { uploaded, folderUrl, sharepointConfigured, notification, email: emailOutcome };
}

// Best-effort stamp of Job.reviewEndedAt — the instant a job leaves
// AWAITING_REVIEW (approved → published, or rejected → rolled up). Paired
// with reviewClaimedAt it gives a review's start→end span for super-admin
// reporting. reviewEndedAt is an additive Track-A column; until db:deploy
// runs the write throws (ColumnNotFound), so we swallow it — reports already
// tolerate a null, and the value starts persisting the moment the column
// lands. Shared by every settle path (this file + the reject routes).
export async function stampReviewEnded(jobId: string): Promise<void> {
  try {
    await db.job.update({ where: { id: jobId }, data: { reviewEndedAt: new Date() } });
  } catch (err) {
    await db.log
      .create({
        data: {
          jobId,
          level: "INFO",
          message: `reviewEndedAt not stamped (${(err as Error).message.slice(0, 100)}) — additive column pending db:deploy`,
        },
      })
      .catch(() => {});
  }
}

type StyleApprovalContext = {
  styleId: string;
  jobId: string;
  // Style number = the Style row name; used to find the matching item on the
  // Monday "🛍️ Styles" board (our styles are sourced from the Pre-Order board,
  // which has no relation to it, so we bridge by name).
  styleNumber: string;
  customerName: string;
  businessArea: string | null;
  poNumber: string | null;
  files: Array<{ name: string; webUrl: string | null }>;
  requiredCerts: string[];
  // Supplier the prod specs were delivered to (for the customer notice).
  supplierEmail: string | null;
  // When true (customer delivers own) skip ALL external chain actions — the
  // Monday subitem flip AND the customer-responsible email — keeping only the
  // internal approval + per-PDF state that already landed.
  skipExternal: boolean;
};

// Style-level chain reaction, fired from publishApprovedJob once a job
// publishes. Only acts when the WHOLE style is fully approved — i.e. no other
// job for the style is still queued, running, or awaiting review. Wrapped so
// it NEVER throws: the job is already approved + published, and a Monday or
// email failure must not unwind that.
export async function onStyleFullyApproved(ctx: StyleApprovalContext): Promise<void> {
  try {
    const pending = await db.job.count({
      where: {
        styleId: ctx.styleId,
        status: { in: ["QUEUED", "RUNNING", "AWAITING_REVIEW"] },
      },
    });
    if (pending > 0) {
      await db.log.create({
        data: {
          jobId: ctx.jobId,
          level: "INFO",
          message: `style not fully approved yet — ${pending} output run(s) still pending; chain reaction deferred`,
        },
      });
      return;
    }

    if (ctx.skipExternal) {
      await db.log.create({
        data: {
          jobId: ctx.jobId,
          level: "INFO",
          message:
            "style fully approved · customer delivers own — Monday subitems + customer-responsible email skipped (internal approval only)",
        },
      });
      return;
    }

    // 1) Monday: flip subitems 01e/01f to Approved + resolve customer contact.
    const monday = await applyStyleApprovalToMonday(ctx.styleNumber, ctx.jobId);
    const mondayMsg = monday.found
      ? `monday item ${monday.stylesBoardItemId} · approved [${monday.subitemsUpdated.join(", ") || "none"}]` +
        (monday.subitemsSimulated.length
          ? ` · simulated/write-backs-off [${monday.subitemsSimulated.join(", ")}]`
          : "") +
        (monday.subitemsMissing.length ? ` · missing [${monday.subitemsMissing.join(", ")}]` : "") +
        (monday.subitemErrors.length ? ` · errors [${monday.subitemErrors.join("; ")}]` : "")
      : `monday: ${monday.notes.join("; ")}`;
    await db.log.create({
      data: {
        jobId: ctx.jobId,
        level: monday.subitemErrors.length ? "WARN" : "INFO",
        message: `style fully approved — ${mondayMsg}`,
      },
    });

    // 2) Customer-responsible email (the people column on the Styles board).
    const recipients = monday.customerResponsible.map((r) => r.email);
    if (recipients.length === 0) {
      await db.log.create({
        data: {
          jobId: ctx.jobId,
          level: "INFO",
          message: `customer-responsible email skipped — no recipient resolved (${monday.notes.join("; ") || "none"})`,
        },
      });
      return;
    }
    const base = process.env.PROD_SPEC_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
    const email = customerApprovalEmail({
      styleName: ctx.styleNumber,
      customerName: ctx.customerName,
      businessArea: ctx.businessArea,
      poNumber: ctx.poNumber,
      files: ctx.files,
      certificates: ctx.requiredCerts,
      supplierEmail: ctx.supplierEmail,
      styleUrl: `${base}/styles/${ctx.styleId}`,
    });
    const outcome = await dispatchEmail({
      type: "SUPPLIER_APPROVAL",
      to: recipients,
      subject: email.subject,
      html: email.html,
      text: email.text,
      jobId: ctx.jobId,
      styleId: ctx.styleId,
    });
    await db.log.create({
      data: {
        jobId: ctx.jobId,
        level: outcome.status === "FAILED" ? "WARN" : "INFO",
        message: `customer-responsible email ${outcome.status} · To: ${recipients.join(", ")}`,
      },
    });
  } catch (err) {
    await db.log
      .create({
        data: {
          jobId: ctx.jobId,
          level: "WARN",
          message: `style chain reaction failed: ${(err as Error).message}`,
        },
      })
      .catch(() => {});
  }
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
