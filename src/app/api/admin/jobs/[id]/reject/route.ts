import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { getItem, columnText } from "@/lib/monday/client";
import { writeBackStatus } from "@/lib/monday/writeback";
import { resolveNotificationsForJob } from "@/lib/notifications/user-notifications";
import { createOrReopenRejectionTicket } from "@/lib/tickets/rejection-tickets";
import { stampReviewEnded } from "@/lib/publish/publish-approved-job";

export const runtime = "nodejs";

const SCHEMA = z.object({ reason: z.string().min(1).max(500) });

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

  // Best-effort write-back to Monday — GATED by the write-back master switch
  // and logged with readable from→to. When the switch is off, this records
  // "would set Status: <from> → Rejected" and sends nothing. If the column id
  // isn't configured we still return success: rejection is a local decision.
  const statusColumnId = process.env.MONDAY_STATUS_COLUMN_ID;
  if (statusColumnId) {
    try {
      // Read the live status first so the log shows the real "from" value
      // (a read is always safe — the switch only gates the write).
      let currentLabel: string | null = null;
      try {
        const item = await getItem(job.style.mondayItemId);
        currentLabel = item ? columnText(item, statusColumnId) || null : null;
      } catch {
        currentLabel = null;
      }
      await writeBackStatus({
        boardId: job.style.mondayBoardId,
        itemId: job.style.mondayItemId,
        columnId: statusColumnId,
        label: "Rejected",
        currentLabel,
        entity: job.style.name,
        boardLabel: "Pre Order",
        columnTitle: "Status",
        styleNumber: job.style.name,
        jobId: job.id,
      });
    } catch (err) {
      await db.log
        .create({
          data: {
            jobId: job.id,
            level: "WARN",
            message: `monday writeback log failed: ${(err as Error).message}`,
          },
        })
        .catch(() => {});
    }
  }

  return NextResponse.json({ ok: true });
}
