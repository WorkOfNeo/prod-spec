import { NextResponse, type NextRequest } from "next/server";
import { runPendingEanResolutions } from "@/lib/po/ean-runner";
import { getServerSession } from "@/lib/auth-server";
import { getPoEanAutoRunEnabled } from "@/lib/settings/app-settings";

export const runtime = "nodejs";
export const maxDuration = 300;

// Drains PENDING styles (PO number filled → EANs not yet resolved), scraping
// each PO PDF and persisting the per-size EANs. Accepts requests from:
//  - The fire-and-forget trigger after a Monday ingest (sends ?secret=)
//  - Railway cron (sends ?secret=, and ?sweep=1 to also re-queue stuck rows)
//  - The admin "Re-resolve" / batch buttons (signed-in session, no secret)
//
// Reuses JOB_RUNNER_SECRET — same trust boundary as the PDF job runner.
// Returns WHO authorized: "secret" = automation (cron / fire-and-forget
// trigger), "session" = a signed-in operator clicking a button.
async function authSource(req: NextRequest): Promise<"secret" | "session" | null> {
  const secret = process.env.JOB_RUNNER_SECRET;
  const provided = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-job-runner-secret");
  if (secret && provided && timingSafeEqual(secret, provided)) return "secret";

  const session = await getServerSession();
  return session !== null ? "session" : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function POST(req: NextRequest) {
  const source = await authSource(req);
  if (!source) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Automation gate: when the /po-eans auto-run switch is OFF, cron and the
  // post-ingest trigger no-op — queueing still happens, nothing scrapes.
  // Operator-initiated calls (session auth: the per-row "Re-resolve" and
  // batch buttons) always run, switch state notwithstanding.
  if (source === "secret" && !(await getPoEanAutoRunEnabled())) {
    return NextResponse.json({
      skipped: true,
      reason: "PO→EAN auto-run is disabled — queue drains manually from /po-eans",
      processed: 0,
      failed: 0,
      requeued: 0,
      styleIds: [],
    });
  }

  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "5");
  const sweep = req.nextUrl.searchParams.get("sweep") === "1";
  const summary = await runPendingEanResolutions(Math.min(Math.max(limit, 1), 20), { sweep });
  return NextResponse.json(summary);
}

export function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST with ?secret=<JOB_RUNNER_SECRET> or a signed-in session. Add ?sweep=1 to re-queue stuck rows.",
  });
}
