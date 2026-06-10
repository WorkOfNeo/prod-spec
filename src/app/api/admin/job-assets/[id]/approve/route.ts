import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";

export const runtime = "nodejs";

// Per-asset approve. The parent Job's overall status (APPROVED / REJECTED)
// only flips once every asset has been individually decided — until then
// the Job stays AWAITING_REVIEW. This decoupling lets reviewers handle
// each output independently so analytics can isolate which doc types
// trip up most often.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;

  const asset = await db.jobAsset.findUnique({
    where: { id },
    include: { job: true },
  });
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  if (asset.reviewStatus === "APPROVED") {
    return NextResponse.json({ ok: true, alreadyApproved: true });
  }

  // Ship-gate: placeholder artifacts (missing artwork tiles / "No carton
  // EAN") are review-safe, never print-safe. Fix the gaps + re-run instead.
  if (asset.placeholderCount > 0) {
    return NextResponse.json(
      {
        error: `Approval blocked — this document contains ${asset.placeholderCount} placeholder artifact(s) (missing symbol/certificate artwork or missing EAN). Fix the gaps and re-run the output.`,
      },
      { status: 409 },
    );
  }

  await db.jobAsset.update({
    where: { id },
    data: {
      reviewStatus: "APPROVED",
      rejectReason: null,
      reviewedAt: new Date(),
      reviewedById: session.user.id,
    },
  });
  await db.log.create({
    data: {
      jobId: asset.jobId,
      level: "INFO",
      message: `asset ${asset.docType} approved by ${session.user.email}`,
    },
  });

  await maybeSettleJob(asset.jobId);

  return NextResponse.json({ ok: true });
}

// If every asset under a job has been decided, roll the job up.
// All approved → APPROVED. Any rejected → REJECTED.
async function maybeSettleJob(jobId: string): Promise<void> {
  const assets = await db.jobAsset.findMany({
    where: { jobId },
    select: { reviewStatus: true },
  });
  if (assets.length === 0) return;
  const stillPending = assets.some((a) => a.reviewStatus === "PENDING_REVIEW");
  if (stillPending) return;

  const allApproved = assets.every((a) => a.reviewStatus === "APPROVED");
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.status === "APPROVED" || job.status === "REJECTED") return;

  if (allApproved) {
    await db.job.update({
      where: { id: jobId },
      data: { status: "APPROVED", finishedAt: new Date() },
    });
    await db.style.update({
      where: { id: job.styleId },
      data: { status: "APPROVED" },
    });
    await db.log.create({
      data: { jobId, level: "INFO", message: "all assets approved — job rolled up to APPROVED" },
    });
  } else {
    await db.job.update({
      where: { id: jobId },
      data: { status: "REJECTED", finishedAt: new Date() },
    });
    await db.style.update({
      where: { id: job.styleId },
      data: { status: "REJECTED" },
    });
    await db.log.create({
      data: { jobId, level: "INFO", message: "asset(s) rejected — job rolled up to REJECTED" },
    });
  }
}
