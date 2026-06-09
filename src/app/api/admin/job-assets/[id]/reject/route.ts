import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";

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
    include: { job: true },
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

  // Roll the job up if every asset has been decided. Same logic as the
  // approve endpoint — inlined here to keep both routes self-contained.
  const assets = await db.jobAsset.findMany({
    where: { jobId: asset.jobId },
    select: { reviewStatus: true },
  });
  const stillPending = assets.some((a) => a.reviewStatus === "PENDING_REVIEW");
  if (!stillPending && asset.job.status !== "APPROVED" && asset.job.status !== "REJECTED") {
    const allApproved = assets.every((a) => a.reviewStatus === "APPROVED");
    await db.job.update({
      where: { id: asset.jobId },
      data: {
        status: allApproved ? "APPROVED" : "REJECTED",
        finishedAt: new Date(),
      },
    });
    await db.style.update({
      where: { id: asset.job.styleId },
      data: { status: allApproved ? "APPROVED" : "REJECTED" },
    });
  }

  return NextResponse.json({ ok: true });
}
