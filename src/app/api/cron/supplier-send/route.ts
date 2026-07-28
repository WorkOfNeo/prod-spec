import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { isCronAuthorized } from "@/lib/cron/auth";
import { runSupplierSendBatch } from "@/lib/publish/supplier-batch-send";
import { reconcileSupplierSendQueue } from "@/lib/publish/supplier-send-queue";
import { pushQueuedSupplierUploads } from "@/lib/sharepoint/push-queued-to-supplier";
import { verifySupplierUploads } from "@/lib/sharepoint/verify-supplier-uploads";
import { getSupplierBatchSendEnabled } from "@/lib/settings/app-settings";

export const runtime = "nodejs";
export const maxDuration = 300;

// Supplier-send cron — two modes on one route (same secret, same Railway
// service):
//
//   ?uploadOnly=1  — the RECURRING upload sweep (WS3 + WS4). Railway cron hits
//     this every 15–30 min: reconcile the backlog (styles approved before queue
//     capture existed, above the supplierSendMinPo cutoff) into the queue,
//     self-heal-verify already-UPLOADED rows against their real folder (re-arm
//     any whose file went missing), then push every still-pending upload into
//     the suppliers' own SharePoint folders. NO email — files just land "on the
//     go". Rows that used their MAX_PUSH_ATTEMPTS strikes are left floated for
//     the midnight sweep. Records a CronRun (kind "supplier-upload") for
//     /automation activity.
//
//   (no param)     — the nightly batch (WS2b). Railway cron POSTs at midnight:
//     reconcile → full push sweep (incl. floated rows) → ONE digest email per
//     supplier. The admin "Run batch now" button hits this with ?manual=1.
//
// Both modes are flag-gated by supplierBatchSendEnabled inside the libs: with
// the toggle OFF the queue still captures/reconciles (visible on
// /settings/approved) but nothing is pushed and nothing is sent.
export async function POST(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const manual = req.nextUrl.searchParams.get("manual") === "1";
  const uploadOnly = req.nextUrl.searchParams.get("uploadOnly") === "1";

  if (uploadOnly) {
    const startedAt = Date.now();
    const enabled = await getSupplierBatchSendEnabled();
    const reconciled = await reconcileSupplierSendQueue(25);
    // Self-heal (WS4) BEFORE the push: re-check already-"UPLOADED" rows against
    // their real SharePoint folder and re-arm any whose file has gone missing,
    // so the push in the same tick re-uploads them. TTL- + budget-bounded, so
    // most ticks this is one cheap query returning nothing due.
    const verified = await verifySupplierUploads();
    const sweep = await pushQueuedSupplierUploads(); // flag-gated inside; floated rows excluded
    await db.cronRun.create({
      data: {
        kind: "supplier-upload",
        source: manual ? "session" : "secret",
        skipped: !enabled,
        note:
          `reconciled ${reconciled.outputsEnqueued} output(s) across ${reconciled.stylesEnqueued} style(s)` +
          (reconciled.cutoff === null ? " (no PO cutoff set — backfill idle)" : ` (PO ≥ ${reconciled.cutoff})`) +
          `; verify: ${verified.verified} ok / ${verified.healed} self-healed / ${verified.unresolved} unresolved` +
          // A collision is a silent, permanent shortfall — say it out loud in
          // the feed, because no retry counter will ever move for it.
          (verified.collided > 0 ? ` / ${verified.collided} lost to duplicate file names` : "") +
          `; uploads: ${sweep.uploaded} ok / ${sweep.failed} failed / ${sweep.skipped} skipped` +
          (sweep.noFolder > 0 || sweep.ambiguous > 0
            ? ` / ${sweep.noFolder} no PO folder / ${sweep.ambiguous} ambiguous`
            : "") +
          // Surface the first failure reason so /automation says WHY, not just a count.
          (sweep.failures.length > 0 ? ` — e.g. ${sweep.failures[0].message}` : "") +
          (enabled ? "" : " — sending OFF, push skipped"),
        processed: sweep.uploaded,
        failed: sweep.failed,
        enqueued: reconciled.outputsEnqueued,
        // A self-heal re-arm is real activity — count it so the feed's default
        // (activity-only) view surfaces the tick instead of hiding it as idle.
        requeued: verified.healed,
        durationMs: Date.now() - startedAt,
      },
    });
    return NextResponse.json({ ok: true, enabled, reconciled, verified, ...sweep });
  }

  const source = manual ? "manual" : "midnight";
  // The nightly run is self-sufficient: reconcile with a bigger budget first,
  // so a freshly-set cutoff backfills within one night even if the recurring
  // sweep isn't scheduled yet.
  const reconciled = await reconcileSupplierSendQueue(100);
  const result = await runSupplierSendBatch({ source });
  return NextResponse.json({ ok: true, reconciled, ...result });
}

export function GET() {
  return NextResponse.json({
    ok: true,
    hint:
      "POST with ?secret=<JOB_RUNNER_SECRET> or a signed-in admin session. " +
      "?uploadOnly=1 = reconcile + SharePoint push only (no email), for the recurring sweep. " +
      "Sending is gated by the 'Automatic supplier sending' setting.",
  });
}
