import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { resolveNotificationsForJob } from "@/lib/notifications/user-notifications";
import { createOrReopenRejectionTicket } from "@/lib/tickets/rejection-tickets";
import { stampReviewEnded } from "@/lib/publish/publish-approved-job";
import { decodeImageAttachments, MAX_IMAGE_DATA_URL_CHARS } from "@/lib/images/decode-data-url";

export const runtime = "nodejs";

const SCHEMA = z.object({
  // No max length — reviewers need room to explain (DB column is unbounded text).
  reason: z.string().min(1),
  // Optional images attached to the bulk-reject comment — copied onto each
  // cascaded ticket so the screenshot shows on every thread in the log.
  attachments: z
    .array(
      z.object({
        dataUrl: z.string().min(1).max(MAX_IMAGE_DATA_URL_CHARS, "Image too large — keep it under ~5 MB"),
        fileName: z.string().max(255).optional(),
      }),
    )
    .max(4)
    .optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const decodedAttachments = decodeImageAttachments(parsed.data.attachments);
  if (!decodedAttachments.ok) {
    return NextResponse.json({ error: decodedAttachments.error }, { status: 400 });
  }

  const job = await db.job.findUnique({
    where: { id },
    // reviewEndedAt isn't read here and may not be deployed yet — omit it so
    // bulk reject keeps working pre-db:deploy.
    omit: { reviewEndedAt: true },
    include: {
      style: { include: { customer: true, businessAreaRef: true } },
      assets: true,
    },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "AWAITING_REVIEW") {
    return NextResponse.json({ error: `Cannot reject job in status ${job.status}` }, { status: 400 });
  }

  // Snapshot which assets the cascade below is about to reject — those get
  // rejection tickets too, so a blanket "Reject all" reaches the admin's
  // work-log exactly like per-output rejections.
  const cascading = job.assets.filter((a) => a.reviewStatus === "PENDING_REVIEW");

  await db.$transaction([
    db.job.update({
      where: { id: job.id },
      data: { status: "REJECTED", finishedAt: new Date() },
    }),
    db.style.update({
      where: { id: job.styleId },
      data: { status: "REJECTED" },
    }),
    // Cascade the rejection onto every asset that was still awaiting
    // review — gives the Delivered Prod Specs panel + analytics a
    // consistent record. Already-decided assets keep their state.
    db.jobAsset.updateMany({
      where: { jobId: job.id, reviewStatus: "PENDING_REVIEW" },
      data: {
        reviewStatus: "REJECTED",
        rejectReason: parsed.data.reason,
        reviewedAt: new Date(),
        reviewedById: session.user.id,
      },
    }),
    db.reviewAction.create({
      data: { jobId: job.id, userId: session.user.id, action: "REJECTED", reason: parsed.data.reason },
    }),
    db.log.create({
      data: {
        jobId: job.id,
        level: "INFO",
        message: `rejected by ${session.user.email}: ${parsed.data.reason}`,
      },
    }),
  ]);

  // The review just ended (rejected) — stamp reviewEndedAt at the settle seam.
  await stampReviewEnded(job.id);
  // Settled — open dashboard notifications for this job are done.
  await resolveNotificationsForJob(job.id);

  // One rejection ticket per cascaded output (create-or-reopen keeps a
  // single thread per style × variantKey). Sequential on purpose — the
  // reopen lookup must see the previous iteration's writes.
  for (const asset of cascading) {
    try {
      await createOrReopenRejectionTicket({
        asset: { ...asset, job: { styleId: job.styleId, style: job.style } },
        comment: parsed.data.reason,
        reportedById: session.user.id,
        attachments: decodedAttachments.attachments,
      });
    } catch (err) {
      await db.log.create({
        data: {
          jobId: job.id,
          level: "WARN",
          message: `rejection ticket creation failed for ${asset.variantKey ?? asset.docType}: ${(err as Error).message}`,
        },
      });
    }
  }

  // Rejection intentionally performs NO Monday write-back — not even a
  // "Rejected" status. Only APPROVALS write to Monday (the 01e/01f subitem
  // flip in the approval chain-reaction). A rejection is a local decision,
  // surfaced via rejection tickets + the reviewer dashboard, never mirrored
  // to Monday.

  return NextResponse.json({ ok: true });
}
