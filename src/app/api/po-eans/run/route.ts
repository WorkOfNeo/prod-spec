import { NextResponse, type NextRequest } from "next/server";
import { runPendingEanResolutions, estimateEanBatchSize } from "@/lib/po/ean-runner";
import { EAN_BATCH } from "@/lib/po/batch-size";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { getPoEanAutoRunEnabled } from "@/lib/settings/app-settings";

export const runtime = "nodejs";
export const maxDuration = 300;

type AuthSource =
  | { source: "secret" | "session" }
  | { error: { status: 401 | 403; message: string } };

// Drains PENDING styles (PO number filled → EANs not yet resolved), scraping
// each PO PDF and persisting the per-size EANs. Accepts requests from:
//  - The fire-and-forget trigger after a Monday ingest (sends ?secret=)
//  - Railway cron (sends ?secret=, and ?sweep=1 to also re-queue stuck rows)
//  - The admin "Re-resolve" / batch buttons (signed-in ADMIN session, no secret)
//
// Reuses JOB_RUNNER_SECRET — same trust boundary as the PDF job runner.
// Returns WHO authorized: "secret" = automation (cron / fire-and-forget
// trigger), "session" = a signed-in operator clicking a button. The secret
// path is role-agnostic; the interactive session path is ADMIN-only — a
// signed-in REVIEWER must not drain the EAN queue by calling this directly.
async function authSource(req: NextRequest): Promise<AuthSource> {
  const secret = process.env.JOB_RUNNER_SECRET;
  const provided = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-job-runner-secret");
  if (secret && provided && timingSafeEqual(secret, provided)) return { source: "secret" };

  const { session, role } = await getSessionWithRole();
  if (!session) return { error: { status: 401, message: "Unauthorized" } };
  if (!isAdmin(role)) return { error: { status: 403, message: "Requires role: ADMIN" } };
  return { source: "session" };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  const auth = await authSource(req);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error.message }, { status: auth.error.status });
  }
  const source = auth.source;
  const sweep = req.nextUrl.searchParams.get("sweep") === "1";
  // Record cron ticks (sweep) and operator "Run now" (session) for the
  // /automation page — but NOT the high-frequency inline webhook triggers
  // (secret without sweep), which would flood it.
  const record = sweep || source === "session";

  // Automation gate: when the /po-eans auto-run switch is OFF, cron and the
  // post-ingest trigger no-op — queueing still happens, nothing scrapes.
  // Operator-initiated calls (session auth: the per-row "Re-resolve" and
  // batch buttons) always run, switch state notwithstanding.
  if (source === "secret" && !(await getPoEanAutoRunEnabled())) {
    if (record) {
      await db.cronRun.create({
        data: {
          kind: "po-eans",
          source,
          skipped: true,
          note: "auto-run off — queue drains manually from /po-eans",
          durationMs: Date.now() - startedAt,
        },
      });
    }
    return NextResponse.json({
      skipped: true,
      reason: "PO→EAN auto-run is disabled — queue drains manually from /po-eans",
      processed: 0,
      failed: 0,
      requeued: 0,
      styleIds: [],
    });
  }

  // Batch size:
  //  - explicit ?limit= → honoured (manual override, ceiling 50)
  //  - cron sweep / operator "Run now" → duration-aware size that drains the
  //    backlog fast without overrunning maxDuration (see estimateEanBatchSize)
  //  - inline post-ingest nudge (secret, no sweep) → tiny fixed batch: it only
  //    needs to resolve the one style just ingested, not drain the backlog.
  const explicit = req.nextUrl.searchParams.get("limit");
  const dynamic = explicit == null && (sweep || source === "session");
  const limit = explicit != null
    ? Math.min(Math.max(Number(explicit) || EAN_BATCH.min, 1), 50)
    : dynamic
      ? await estimateEanBatchSize()
      : EAN_BATCH.min;

  const summary = await runPendingEanResolutions(limit, {
    sweep,
    softDeadlineMs: EAN_BATCH.softDeadlineMs,
  });
  if (record) {
    await db.cronRun.create({
      data: {
        kind: "po-eans",
        source,
        processed: summary.processed,
        failed: summary.failed,
        requeued: summary.requeued,
        styleIds: summary.styleIds,
        // Surface the chosen batch size on /automation so the sizing is visible.
        note: dynamic ? `auto batch ${limit}` : null,
        durationMs: Date.now() - startedAt,
      },
    });
  }
  return NextResponse.json(summary);
}

export function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST with ?secret=<JOB_RUNNER_SECRET> or a signed-in session. Add ?sweep=1 to re-queue stuck rows.",
  });
}
