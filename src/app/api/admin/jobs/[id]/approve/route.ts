import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { uploadJobAssets } from "@/lib/sharepoint/upload";
import { getFile } from "@/lib/sharepoint/client";
import { sendEmail } from "@/lib/email/client";
import { supplierApprovalEmail } from "@/lib/email/templates/review-notification";
import { getSupplierReviewCcEmails } from "@/lib/settings/app-settings";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;

  const job = await db.job.findUnique({
    where: { id },
    include: {
      assets: true,
      style: { include: { customer: true, supplier: true } },
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "AWAITING_REVIEW") {
    return NextResponse.json({ error: `Cannot approve job in status ${job.status}` }, { status: 400 });
  }

  // Ship-gate: a placeholder artifact (dashed missing-artwork tile, "No
  // carton EAN configured" box) is review-safe but must never reach print.
  // Rejected assets are excluded — their gaps are already being handled.
  const placeholderAssets = job.assets.filter(
    (a) => a.placeholderCount > 0 && a.reviewStatus !== "REJECTED",
  );
  if (placeholderAssets.length > 0) {
    return NextResponse.json(
      {
        error:
          "Approval blocked — document(s) contain placeholder artifacts (missing symbol/certificate artwork or missing EAN). Fix the gaps and re-run the affected outputs.",
        assets: placeholderAssets.map((a) => ({
          fileName: a.fileName,
          displayName: a.displayName,
          placeholderCount: a.placeholderCount,
        })),
      },
      { status: 409 },
    );
  }

  // Deterministic folder layout: prodspec/<customer-slug>/<supplier-slug?>/<style-id>.
  // Once the SharePoint folder convention is finalised, parse Supplier.sharepointUrl
  // (which is the supplier's *hyperlink* in their portal, not an upload path).
  const customerSlug = job.style.customer.slug;
  const supplierSlug = job.style.supplier
    ? slugify(job.style.supplier.name)
    : null;
  const folderPath = [
    "prodspec",
    customerSlug,
    ...(supplierSlug ? [supplierSlug] : []),
    job.style.mondayItemId,
  ].join("/");

  const uploaded = await uploadJobAssets({
    folderPath,
    assets: job.assets.map((a) => ({ fileName: a.fileName, docType: a.docType, pdf: Buffer.from(a.pdf) })),
  });

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
        reviewedById: session.user.id,
      },
    }),
    db.reviewAction.create({
      data: { jobId: job.id, userId: session.user.id, action: "APPROVED" },
    }),
    db.log.create({
      data: {
        jobId: job.id,
        level: "INFO",
        message: `approved by ${session.user.email} · uploaded ${uploaded.length} files`,
        payload: { uploaded },
      },
    }),
  ]);

  // Resolve the SharePoint *folder* link for the email. getFile issues a
  // driveItem GET at the folder path (it works for folders too and returns
  // their webUrl); fall back to the supplier's portal link, then the first
  // uploaded file's webUrl.
  let folderUrl: string | null = null;
  try {
    folderUrl = (await getFile(folderPath))?.webUrl ?? null;
  } catch {
    folderUrl = null;
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
    new Set(
      [...reviewCc, supplier?.contactEmail ?? ""]
        .map((e) => e.trim())
        .filter(Boolean),
    ),
  );
  const ccDisplay = ccList.length > 0 ? ccList.join(", ") : null;

  // Summary surfaced back to the reviewer (and written to the job log) so the
  // recipients can be confirmed even when email sending is turned off. When
  // RESEND_API_KEY / EMAIL_FROM aren't set, sendEmail no-ops and returns
  // { sent: false } — we still report exactly who it WOULD have gone to.
  const notification: {
    to: string | null;
    cc: string | null;
    attachments: number;
    folderUrl: string | null;
    sent: boolean;
    note?: string;
  } = { to: supplierEmail, cc: ccDisplay, attachments: 0, folderUrl, sent: false };

  if (supplierEmail) {
    const isCorrection = job.triggerSource === "MANUAL_RERUN";
    const email = supplierApprovalEmail({
      supplierEmail,
      styleName: job.style.name,
      styleNumber: job.style.mondayItemId,
      customerName: job.style.customer.name,
      files: uploaded.map((f) => ({ name: f.name, webUrl: f.webUrl })),
      folderUrl,
      isCorrection,
    });
    // Attach the generated PDFs so the supplier can review them directly,
    // not only via the SharePoint link.
    const attachments = job.assets.map((a) => ({
      filename: a.fileName,
      content: Buffer.from(a.pdf),
    }));
    const sendResult = await sendEmail({
      to: supplierEmail,
      cc: ccList.length > 0 ? ccList : undefined,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments,
    });
    notification.attachments = attachments.length;
    notification.sent = sendResult.sent;
    if (!sendResult.sent) {
      notification.note = "Email sending is off (RESEND_API_KEY / EMAIL_FROM not set) — preview only.";
    }
    const verb = sendResult.sent ? "sent" : "PREVIEW (sending off) — would send";
    await db.log.create({
      data: {
        jobId: job.id,
        level: "INFO",
        message: `supplier review email ${verb} · To: ${supplierEmail}${ccDisplay ? ` · CC: ${ccDisplay}` : ""} · ${attachments.length} attachment(s)${folderUrl ? ` · folder: ${folderUrl}` : ""}${isCorrection ? " · correction" : ""}`,
      },
    });
  } else {
    notification.note =
      "No supplier email resolved — set the Monday supplier email column (MONDAY_SUPPLIER_COL_EMAIL) + re-sync, or set SUPPLIER_NOTIFICATION_EMAIL.";
    await db.log.create({
      data: {
        jobId: job.id,
        level: "WARN",
        message:
          "No supplier email — board field empty and SUPPLIER_NOTIFICATION_EMAIL unset; files uploaded but no recipient resolved",
      },
    });
  }

  return NextResponse.json({ ok: true, uploaded, notification });
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
