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
      style: { include: { customer: true } },
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "AWAITING_REVIEW") {
    return NextResponse.json({ error: `Cannot approve job in status ${job.status}` }, { status: 400 });
  }

  const folderPath = job.style.customer.sharepointPath ?? `prodspec/${job.style.customer.slug}/${job.style.mondayItemId}`;

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

  const supplierEmail = job.style.customer.supplierEmail;
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
        message: "no supplier email on customer record — files uploaded but supplier was not notified",
      },
    });
  }

  return NextResponse.json({ ok: true, uploaded });
}
