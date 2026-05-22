import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { isChallenge, isEventPayload, verifyWebhookRequest } from "@/lib/monday/webhook";
import { ingestMondayItem } from "@/lib/monday/ingest";
import { enqueueGenerationJob } from "@/lib/queue/enqueue";
import { triggerRunner } from "@/lib/queue/trigger";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Initial endpoint verification — Monday POSTs { challenge } once on create_webhook.
  if (isChallenge(body)) {
    return NextResponse.json({ challenge: body.challenge });
  }

  const verified = verifyWebhookRequest(req);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: 401 });
  }

  if (!isEventPayload(body)) {
    return NextResponse.json({ error: "Unrecognized payload" }, { status: 400 });
  }

  const { event } = body;

  await db.log.create({
    data: {
      level: "INFO",
      message: `monday.webhook ${event.type}`,
      payload: body as unknown as object,
    },
  });

  if (event.pulseId) {
    try {
      const result = await ingestMondayItem(event.pulseId);
      await db.log.create({
        data: {
          level: "INFO",
          message: `style ${result.styleId} synced (${result.completionPct}%)`,
          payload: { styleId: result.styleId, completionPct: result.completionPct, missingFields: result.missingFields },
        },
      });

      if (result.completionPct === 100) {
        const inflight = await db.job.count({
          where: { styleId: result.styleId, status: { in: ["QUEUED", "RUNNING"] } },
        });
        if (inflight === 0) {
          await enqueueGenerationJob({ styleId: result.styleId, triggerSource: "WEBHOOK" });
          await triggerRunner();
        }
      }
    } catch (err) {
      await db.log.create({
        data: {
          level: "ERROR",
          message: `failed to ingest item ${event.pulseId}: ${(err as Error).message}`,
          payload: { pulseId: event.pulseId, error: (err as Error).message },
        },
      });
    }
  }

  return NextResponse.json({ ok: true });
}

export function GET() {
  return NextResponse.json({ ok: true, hint: "POST only. Use Monday create_webhook." });
}
