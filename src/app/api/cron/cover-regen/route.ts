import { NextResponse, type NextRequest } from "next/server";
import { isCronAuthorized } from "@/lib/cron/auth";
import { runDueCoverRegens } from "@/lib/pdf/cover-regen-schedule";

export const runtime = "nodejs";
// A drain may render several covers (Chromium) — give it headroom.
export const maxDuration = 300;

// Cover-regen backstop. The durable half of the debounced auto-refresh: an
// output approval/rejection stamps its style into the debounce ledger and arms
// an in-process timer, but a restart/deploy (or a second instance) can drop that
// timer. This cron drains every style whose debounce window has elapsed, so the
// cover always converges even when the fast path is lost. Idempotent — safe to
// run as often as you like; Railway cron every 1–2 min keeps latency low.
//
//   POST/GET /api/cron/cover-regen?secret=$JOB_RUNNER_SECRET
async function handle(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runDueCoverRegens();
  return NextResponse.json({ ok: true, ...result });
}

export const POST = handle;
export const GET = handle;
