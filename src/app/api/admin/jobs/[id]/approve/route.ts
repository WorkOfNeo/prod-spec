import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { uploadJobAssets } from "@/lib/sharepoint/upload";
import { sendEmail } from "@/lib/email/client";
import { supplierApprovalEmail } from "@/lib/email/templates/review-notification";

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

  // Supplier email isn't a Monday-mirrored field; the M1 Customer.supplierEmail
  // was dropped in favour of the per-Supplier mirror, which doesn't carry an
  // email yet. Until that's added, fall back to REVIEW_NOTIFICATION_EMAIL so
  // approval at least surfaces to an operator who can forward manually.
  const supplierEmail = process.env.SUPPLIER_NOTIFICATION_EMAIL ?? null;
  if (supplierEmail) {
    const isCorrection = job.triggerSource === "MANUAL_RERUN";
    const email = supplierApprovalEmail({
      supplierEmail,
      styleName: job.style.name,
      styleNumber: job.style.mondayItemId,
      customerName: job.style.customer.name,
      files: uploaded.map((f) => ({ name: f.name, webUrl: f.webUrl })),
      isCorrection,
    });
    await sendEmail({ to: supplierEmail, subject: email.subject, html: email.html, text: email.text });
    await db.log.create({
      data: {
        jobId: job.id,
        level: "INFO",
        message: `supplier email sent to ${supplierEmail}${isCorrection ? " (correction)" : ""}`,
      },
    });
  } else {
    await db.log.create({
      data: {
        jobId: job.id,
        level: "WARN",
        message: "SUPPLIER_NOTIFICATION_EMAIL not set — files uploaded but supplier was not notified",
      },
    });
  }

  return NextResponse.json({ ok: true, uploaded });
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
