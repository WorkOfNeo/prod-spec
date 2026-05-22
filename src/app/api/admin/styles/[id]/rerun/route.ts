import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { triggerRunner } from "@/lib/queue/trigger";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;

  const style = await db.style.findUnique({ where: { id } });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  const inflight = await db.job.count({
    where: { styleId: id, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inflight > 0) {
    return NextResponse.json({ error: "A job is already in flight for this style" }, { status: 409 });
  }

  const { jobId } = await enqueueGenerationJob({ styleId: id, triggerSource: "MANUAL_RERUN" });
  await db.style.update({ where: { id }, data: { status: "GENERATING" } });
  await db.log.create({
    data: { jobId, level: "INFO", message: `manual re-run requested by ${session.user.email}` },
  });
  await triggerRunner();

  return NextResponse.json({ ok: true, jobId });
}
