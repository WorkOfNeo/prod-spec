import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { resolveNotificationsForJob } from "@/lib/notifications/user-notifications";
import { publishApprovedJob, PublishError } from "@/lib/publish/publish-approved-job";
import { claimReviewIfUnclaimed } from "@/lib/review-flow/claim";
import { resolveRejectionTicketsFor } from "@/lib/tickets/rejection-tickets";

export const runtime = "nodejs";
// Approving the LAST pending asset rolls the job up and publishes —
// SharePoint upload + supplier email can take a while.
export const maxDuration = 120;

// Per-asset approve. The parent Job's overall status (APPROVED / REJECTED)
// only flips once every asset has been individually decided — until then
// the Job stays AWAITING_REVIEW. This decoupling lets reviewers handle
// each output independently so analytics can isolate which doc types
// trip up most often.
//
// When the LAST pending asset is approved (and none were rejected) the
// roll-up calls publishApprovedJob — SharePoint upload + supplier email —
// exactly like the job-level "Approve all & publish" button. The response
// then carries `settled` + `email` so the review screen can show what was
// sent (or simulated while RESEND_EMAILS is off).
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
  // Deciding IS taking responsibility — implicit claim when nobody pressed
  // the "Start review" popup first (first writer wins, no-op otherwise).
  await claimReviewIfUnclaimed(asset.jobId, session.user.id);
  await db.log.create({
    data: {
      jobId: asset.jobId,
      level: "INFO",
      message: `asset ${asset.docType} approved by ${session.user.email}`,
    },
  });

  // Approving an output closes its rejection-ticket thread (if any).
  const resolved = await resolveRejectionTicketsFor(asset.job.styleId, [asset.variantKey]);
  if (resolved > 0) {
    await db.log.create({
      data: {
        jobId: asset.jobId,
        level: "INFO",
        message: `resolved ${resolved} rejection ticket(s) for ${asset.variantKey ?? asset.docType}`,
      },
    });
  }

  return NextResponse.json(await maybeSettleJob(asset.jobId, session.user.id));
}

type SettleResult = {
  ok: true;
  settled?: "APPROVED" | "REJECTED";
  // Present when the roll-up published (settled === "APPROVED").
  uploadedCount?: number;
  folderUrl?: string | null;
  notification?: unknown;
  email?: unknown;
  // Publish blew up (e.g. SharePoint outage). The job stays
  // AWAITING_REVIEW so "Approve all & publish" can retry it.
  publishError?: string;
};

// If every asset under a job has been decided, roll the job up.
// All approved → publish (statuses flip inside publishApprovedJob).
// Any rejected → REJECTED.
async function maybeSettleJob(jobId: string, userId: string): Promise<SettleResult> {
  const assets = await db.jobAsset.findMany({
    where: { jobId },
    select: { reviewStatus: true },
  });
  if (assets.length === 0) return { ok: true };
  const stillPending = assets.some((a) => a.reviewStatus === "PENDING_REVIEW");
  if (stillPending) return { ok: true };

  const allApproved = assets.every((a) => a.reviewStatus === "APPROVED");
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.status === "APPROVED" || job.status === "REJECTED") return { ok: true };

  if (allApproved) {
    await db.log.create({
      data: { jobId, level: "INFO", message: "all assets approved — publishing (upload + supplier email)" },
    });
    try {
      const result = await publishApprovedJob(jobId, userId);
      return {
        ok: true,
        settled: "APPROVED",
        uploadedCount: result.uploaded.length,
        folderUrl: result.folderUrl,
        notification: result.notification,
        email: result.email,
      };
    } catch (err) {
      const message = err instanceof PublishError ? err.message : (err as Error).message;
      await db.log.create({
        data: {
          jobId,
          level: "WARN",
          message: `publish after roll-up failed: ${message} — job stays AWAITING_REVIEW, retry via "Approve all & publish"`,
        },
      });
      return { ok: true, publishError: message };
    }
  }

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
  // Settled — open dashboard notifications for this job are done. (The
  // approved branch resolves inside publishApprovedJob.)
  await resolveNotificationsForJob(jobId);
  return { ok: true, settled: "REJECTED" };
}
