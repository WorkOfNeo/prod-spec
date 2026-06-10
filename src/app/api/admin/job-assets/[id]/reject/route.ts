import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { createOrReopenRejectionTicket } from "@/lib/tickets/rejection-tickets";

export const runtime = "nodejs";

const SCHEMA = z.object({
  // Free-text reason for now. Analytics groups by docType + leading
  // words; categorisation comes later if reviewer volume justifies it.
  reason: z.string().min(1).max(500),
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

  const asset = await db.jobAsset.findUnique({
    where: { id },
    include: {
      job: {
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
  }

  return NextResponse.json({ ok: true, ticketId: ticket.ticketId, reopened: ticket.reopened, settled });
}
