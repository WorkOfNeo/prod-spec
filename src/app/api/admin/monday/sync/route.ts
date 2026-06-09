import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { getAllBoardItems } from "@/lib/monday/client";
import { ingestMondayItem } from "@/lib/monday/ingest";

export const runtime = "nodejs";

const BODY_SCHEMA = z.object({
  boardId: z.string().min(1),
});

// One-time board backfill ("the fill"). Pulls every item on a board into the
// Style mirror. Deliberately MIRROR-ONLY: it does NOT enqueue generation jobs
// or email reviewers — ongoing webhooks drive the pipe once flags are flipped.
// Idempotent: ingest upserts by mondayItemId, so re-running is safe.
export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { boardId } = parsed.data;

  let items;
  try {
    items = await getAllBoardItems(boardId);
  } catch (err) {
    await db.log.create({
      data: {
        level: "ERROR",
        message: `monday.backfill board ${boardId} failed to fetch: ${(err as Error).message}`,
        payload: { boardId, error: (err as Error).message },
      },
    });
    return NextResponse.json({ error: `Failed to fetch board items: ${(err as Error).message}` }, { status: 502 });
  }

  let ready = 0;
  let pending = 0;
  const failed: Array<{ itemId: string; error: string }> = [];

  for (const item of items) {
    try {
      const result = await ingestMondayItem(item.id, item);
      if (result.completionPct === 100) ready += 1;
      else pending += 1;
    } catch (err) {
      failed.push({ itemId: String(item.id), error: (err as Error).message });
    }
  }

  const summary = { boardId, total: items.length, synced: ready + pending, ready, pending, failed: failed.length };

  await db.log.create({
    data: {
      level: failed.length > 0 ? "WARN" : "INFO",
      message: `monday.backfill board ${boardId}: ${summary.synced}/${summary.total} mirrored (${ready} ready, ${pending} pending, ${failed.length} failed)`,
      payload: { ...summary, failed } as unknown as object,
    },
  });

  return NextResponse.json({ ...summary, failed });
}
