// POST /api/admin/jobs/[id]/claim-review
//
// The review screen's "Start review" popup (test-phase machinery — see
// lib/review-flow/flags.ts). Marks the current user as responsible for
// seeing this review through; first writer wins, so two reviewers racing
// the popup can't both own it. Decisions auto-claim through the same
// helper, making the explicit claim optional but the ownership invariant.

import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { claimReviewIfUnclaimed } from "@/lib/review-flow/claim";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const job = await db.job.findUnique({
    where: { id },
    select: { id: true, status: true, reviewClaimedById: true },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "AWAITING_REVIEW") {
    return NextResponse.json({ error: `Job is ${job.status}, not awaiting review` }, { status: 409 });
  }

  const claimed = await claimReviewIfUnclaimed(job.id, auth.userId);
  if (claimed) {
    await db.log.create({
      data: { jobId: job.id, level: "INFO", message: "review claimed — reviewer took responsibility via Start review" },
    });
    return NextResponse.json({ ok: true, claimed: true });
  }

  // Lost the race (or re-posted): report the standing owner.
  const current = await db.job.findUnique({
    where: { id: job.id },
    select: { reviewClaimedById: true, reviewClaimedBy: { select: { name: true, email: true } } },
  });
  return NextResponse.json({
    ok: true,
    claimed: false,
    alreadyClaimedByYou: current?.reviewClaimedById === auth.userId,
    claimedBy: current?.reviewClaimedBy?.name || current?.reviewClaimedBy?.email || null,
  });
}
