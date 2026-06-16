import { NextResponse, type NextRequest } from "next/server";
import { isCronAuthorized } from "@/lib/cron/auth";
import { reconcileCustomerBusinessAreaCombos } from "@/lib/combos/reconcile";
import { runAndRespond } from "@/lib/monday/sync-route";

export const runtime = "nodejs";
export const maxDuration = 300;

// Reconcile the Customer × Business-Area combo registry on demand. Wired to
// Railway cron as a backstop (catches webhook-created styles between syncs),
// and doubles as the dashboard's "Rescan now" button — a signed-in admin
// session satisfies isCronAuthorized, so no secret is needed from the UI.
// Style syncs already reconcile inline; this is the standalone path.
export async function POST(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runAndRespond("detect-combos", () => reconcileCustomerBusinessAreaCombos());
}

export function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST with ?secret=<JOB_RUNNER_SECRET> or signed-in admin session.",
  });
}
