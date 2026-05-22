import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { changeItemValue } from "@/lib/monday/client";

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
    include: { style: true },
  });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "AWAITING_REVIEW") {
    return NextResponse.json({ error: `Cannot reject job in status ${job.status}` }, { status: 400 });
  }

  await db.$transaction([
    db.job.update({
      where: { id: job.id },
      data: { status: "REJECTED", finishedAt: new Date() },
    }),
    db.style.update({
      where: { id: job.styleId },
      data: { status: "REJECTED" },
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

  // Best-effort write-back to Monday. If the column id isn't configured
  // or the call fails we still return success — rejection is a local
  // decision, the Monday note is optional.
  const statusColumnId = process.env.MONDAY_STATUS_COLUMN_ID;
  if (statusColumnId) {
    try {
      await changeItemValue({
        boardId: job.style.mondayBoardId,
        itemId: job.style.mondayItemId,
        columnId: statusColumnId,
        value: JSON.stringify({ label: "Rejected" }),
      });
    } catch (err) {
      await db.log.create({
        data: { jobId: job.id, level: "WARN", message: `monday writeback failed: ${(err as Error).message}` },
      });
    }
  }

  return NextResponse.json({ ok: true });
}
