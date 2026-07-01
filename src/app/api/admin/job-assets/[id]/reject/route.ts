import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { resolveNotificationsForJob } from "@/lib/notifications/user-notifications";
import { claimReviewIfUnclaimed } from "@/lib/review-flow/claim";
import { createOrReopenRejectionTicket } from "@/lib/tickets/rejection-tickets";
import { stampReviewEnded } from "@/lib/publish/publish-approved-job";
import { decodeImageAttachments, MAX_IMAGE_DATA_URL_CHARS } from "@/lib/images/decode-data-url";

export const runtime = "nodejs";

const SCHEMA = z.object({
  // Free-text reason for now. Analytics groups by docType + leading
  // words; categorisation comes later if reviewer volume justifies it.
  // No max length — reviewers need room to explain (DB column is unbounded text).
  reason: z.string().min(1),
  // Up to 4 images the reviewer attached to the comment (resized client-side),
  // sent inline as base64 data URLs and decoded below.
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
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

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

  const asset = await db.jobAsset.findUnique({
    where: { id },
    include: {
      job: {
        // reviewEndedAt isn't read here and may not be deployed yet — omit it
        // so the reject path keeps working pre-db:deploy.
        omit: { reviewEndedAt: true },
        include: {
          style: { include: { customer: true, businessAreaRef: true } },
        },
      },
    },
  });
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  await db.jobAsset.update({
    where: { id },
    data: {
      reviewStatus: "REJECTED",
      rejectReason: parsed.data.reason,
      reviewedAt: new Date(),
      reviewedById: session.user.id,
    },
  });
  // Deciding IS taking responsibility — implicit claim when nobody pressed
  // the "Start review" popup first (first writer wins, no-op otherwise).
  await claimReviewIfUnclaimed(asset.jobId, session.user.id);
  await db.log.create({
    data: {
      jobId: asset.jobId,
      level: "INFO",
      message: `asset ${asset.docType} rejected by ${session.user.email}: ${parsed.data.reason}`,
    },
  });

  // The comment lands in the rejection log (one ticket per style ×
  // variantKey thread — a re-rejection after a fix reopens the existing
  // ticket). This is what the admin works from at /settings/rejection-log.
  const ticket = await createOrReopenRejectionTicket({
    asset,
    comment: parsed.data.reason,
    reportedById: session.user.id,
    attachments: decodedAttachments.attachments,
  });
  await db.log.create({
    data: {
      jobId: asset.jobId,
      level: "INFO",
      message: `rejection ticket ${ticket.reopened ? "reopened" : "created"} (${ticket.ticketId}) for ${asset.variantKey ?? asset.docType}`,
    },
  });

  // Roll the job up if every asset has been decided. The all-approved
  // branch can't happen from here (this asset just got rejected), so the
  // roll-up is always to REJECTED.
  const assets = await db.jobAsset.findMany({
    where: { jobId: asset.jobId },
    select: { reviewStatus: true },
  });
  const stillPending = assets.some((a) => a.reviewStatus === "PENDING_REVIEW");
  let settled: "REJECTED" | undefined;
  if (!stillPending && asset.job.status !== "APPROVED" && asset.job.status !== "REJECTED") {
    settled = "REJECTED";
    await db.job.update({
      where: { id: asset.jobId },
      data: { status: "REJECTED", finishedAt: new Date() },
    });
    await db.style.update({
      where: { id: asset.job.styleId },
      data: { status: "REJECTED" },
    });
    await db.log.create({
      data: { jobId: asset.jobId, level: "INFO", message: "asset(s) rejected — job rolled up to REJECTED" },
    });
    // The review just ended (rejected) — stamp reviewEndedAt at the settle seam.
    await stampReviewEnded(asset.jobId);
    // Settled — open dashboard notifications for this job are done.
    await resolveNotificationsForJob(asset.jobId);
  }

  return NextResponse.json({ ok: true, ticketId: ticket.ticketId, reopened: ticket.reopened, settled });
}
