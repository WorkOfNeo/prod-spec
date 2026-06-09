import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { uploadJobAssets } from "@/lib/sharepoint/upload";
import { getFile } from "@/lib/sharepoint/client";
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
  const ccEmail = supplier?.contactEmail?.trim() || null;
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
    await sendEmail({
      to: supplierEmail,
      cc: ccEmail ?? undefined,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments,
    });
    await db.log.create({
      data: {
        jobId: job.id,
        level: "INFO",
        message: `supplier review email sent to ${supplierEmail}${ccEmail ? ` (cc ${ccEmail})` : ""} · ${attachments.length} attachment(s)${isCorrection ? " · correction" : ""}`,
      },
    });
  } else {
    await db.log.create({
      data: {
        jobId: job.id,
        level: "WARN",
        message:
          "No supplier email — board field empty and SUPPLIER_NOTIFICATION_EMAIL unset; files uploaded but supplier was not notified",
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
