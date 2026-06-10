import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { runPendingJobs } from "@/lib/queue/runner";

export const runtime = "nodejs";
// Rendering 6 PDFs in sequence can take a while on a cold Puppeteer.
export const maxDuration = 300;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;

  // Optional scope: { variantKeys: ["coop-dk-license-…"] } runs just those
  // outputs (the per-output Run buttons). No/empty body = full re-run.
  let variantKeys: string[] = [];
  try {
    const body = (await req.json()) as { variantKeys?: unknown };
    if (Array.isArray(body?.variantKeys)) {
      variantKeys = body.variantKeys.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // No JSON body — classic full re-run.
  }

  const style = await db.style.findUnique({ where: { id } });
  if (!style) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  const inflight = await db.job.count({
    where: { styleId: id, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (inflight > 0) {
    return NextResponse.json({ error: "A job is already in flight for this style" }, { status: 409 });
  }

  const { jobId } = await enqueueGenerationJob({
    styleId: id,
    triggerSource: "MANUAL_RERUN",
    variantKeys,
  });
  await db.style.update({ where: { id }, data: { status: "GENERATING" } });
  await db.log.create({
    data: {
      jobId,
      level: "INFO",
      message: `manual re-run${
        variantKeys.length > 0 ? ` (outputs: ${variantKeys.join(", ")})` : ""
      } requested by ${session.user.email}`,
    },
  });

  // Run inline. The admin clicked "Re-run" and is waiting on the response;
  // there's no benefit to dispatching to a background runner here. Matches
  // the manual-style flow at /api/admin/styles/manual.
  //
  // (The webhook path keeps using triggerRunner because Monday will retry
  // a slow response, and the webhook should ack fast.)
  const summary = await runPendingJobs(1);

  // Emails this run produced (the review-ready notification) — slim rows
  // so the Run buttons can pop the simulation dialog while RESEND_EMAILS
  // is off. The dialog fetches the body via /api/admin/email-logs/[id].
  const emailRows = await db.emailLog.findMany({
    where: { jobId },
    orderBy: { createdAt: "asc" },
    select: { id: true, type: true, status: true, to: true, cc: true, subject: true, attachments: true },
  });

  return NextResponse.json({
    ok: true,
    jobId,
    jobsProcessed: summary.processed,
    jobsFailed: summary.failed,
    emails: emailRows.map((e) => ({
      emailLogId: e.id,
      type: e.type,
      status: e.status,
      to: e.to,
      cc: e.cc,
      subject: e.subject,
      attachments: e.attachments,
    })),
  });
}
