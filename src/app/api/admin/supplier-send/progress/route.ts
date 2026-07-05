import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { MAX_PUSH_ATTEMPTS } from "@/lib/sharepoint/push-queued-to-supplier";

export const runtime = "nodejs";

// Live progress for the supplier-upload sweep — the poll target behind the
// progress bar on /settings/approved (same pattern as the bulk-run widget on
// /styles). One cheap read per poll: queue status counts + the recent
// supplier-upload CronRun ticks, from which the client derives rate and ETA.
export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [statusGroups, floated, lastTick, activeTicks] = await Promise.all([
    db.supplierSendQueueItem.groupBy({
      by: ["sharePointStatus"],
      where: { sentAt: null },
      _count: { _all: true },
    }),
    db.supplierSendQueueItem.count({
      where: { sentAt: null, sharePointStatus: "FAILED", pushAttempts: { gte: MAX_PUSH_ATTEMPTS } },
    }),
    // Heartbeat: the newest sweep tick, active or idle — "when did the cron
    // last look".
    db.cronRun.findFirst({
      where: { kind: "supplier-upload" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, processed: true, failed: true, enqueued: true, durationMs: true, skipped: true },
    }),
    // Speed sample: recent ticks that actually uploaded something.
    db.cronRun.findMany({
      where: { kind: "supplier-upload", processed: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { createdAt: true, processed: true, durationMs: true },
    }),
  ]);

  const counts = { UPLOADED: 0, PENDING: 0, FAILED: 0, SKIPPED: 0 } as Record<string, number>;
  for (const g of statusGroups) counts[g.sharePointStatus] = g._count._all;

  // Uploads per minute across the recent active ticks (wall-clock of the
  // sweep itself, not the 5-min gaps between ticks — this is "how fast it
  // uploads when it runs", which is what ETA needs).
  const totalUploaded = activeTicks.reduce((s, t) => s + t.processed, 0);
  const totalMs = activeTicks.reduce((s, t) => s + (t.durationMs ?? 0), 0);
  const ratePerMin = totalMs > 0 ? totalUploaded / (totalMs / 60_000) : null;

  return NextResponse.json({
    uploaded: counts.UPLOADED,
    pending: counts.PENDING,
    failed: counts.FAILED,
    skipped: counts.SKIPPED,
    floated,
    ratePerMin,
    lastTick: lastTick
      ? {
          at: lastTick.createdAt,
          uploaded: lastTick.processed,
          failed: lastTick.failed,
          backfilled: lastTick.enqueued,
          durationMs: lastTick.durationMs,
          skippedRun: lastTick.skipped,
        }
      : null,
  });
}
