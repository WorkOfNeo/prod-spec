import { NextResponse, type NextRequest } from "next/server";
import { isCronAuthorized } from "@/lib/cron/auth";
import { syncCustomers } from "@/lib/monday/sync";
import { runAndRespond } from "@/lib/monday/sync-route";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runAndRespond("sync-customers", () => syncCustomers());
}

export function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST with ?secret=<JOB_RUNNER_SECRET> or signed-in admin session.",
  });
}
