import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { maybeSettleJob } from "@/lib/publish/settle-job";
import { claimReviewIfUnclaimed } from "@/lib/review-flow/claim";
import { resolveRejectionTicketsFor } from "@/lib/tickets/rejection-tickets";
import { deliverOutput } from "@/lib/publish/deliver-output";
import { perOutputDeliveryEnabled } from "@/lib/review-flow/flags";
import { enqueueApprovedAsset } from "@/lib/publish/supplier-send-queue";

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
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  const { id } = await ctx.params;

  const asset = await db.jobAsset.findUnique({
    where: { id },
    // reviewEndedAt (additive Track-A column) isn't read here and may not be
    // deployed yet — omit it so the approve path keeps working pre-db:deploy.
    include: { job: { omit: { reviewEndedAt: true } } },
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

  // Capture the approval into the supplier-send queue (WS2) — fail-soft, and
  // ALWAYS (queue populates even while batch sending is flag-gated off).
  try {
    await enqueueApprovedAsset({
      id: asset.id,
      styleId: asset.job.styleId,
      variantKey: asset.variantKey,
      docType: asset.docType,
      displayName: asset.displayName,
    });
  } catch (err) {
    console.warn(`[supplier-send-queue] enqueue failed for asset ${asset.id}:`, err);
  }

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

  // Per-output delivery (phase 3) — gated off. When enabled, an approved
  // output notifies the supplier on its own and we skip the job-level publish;
  // the job no longer needs to "settle" as a unit (status is derived from the
  // outputs). Until then, the job roll-up + publish path is unchanged.
  if (perOutputDeliveryEnabled()) {
    const email = await deliverOutput(id);
    return NextResponse.json({ ok: true, perOutput: true, email });
  }

  return NextResponse.json(await maybeSettleJob(asset.jobId, session.user.id));
}
