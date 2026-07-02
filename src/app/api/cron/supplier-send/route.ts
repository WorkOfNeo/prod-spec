import { NextResponse, type NextRequest } from "next/server";
import { isCronAuthorized } from "@/lib/cron/auth";
import { runSupplierSendBatch } from "@/lib/publish/supplier-batch-send";

export const runtime = "nodejs";
export const maxDuration = 300;

// Nightly supplier-send batch (WS2b). Railway cron POSTs here at midnight with
// ?secret=<JOB_RUNNER_SECRET>; the admin "Run now" button can also hit it with
// a signed-in session. Groups the unsent send-queue by supplier and sends ONE
// digest per supplier. Flag-gated inside runSupplierSendBatch: with
// supplierBatchSendEnabled OFF it's a dry run (records intent, sends nothing).
export async function POST(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const source = req.nextUrl.searchParams.get("manual") === "1" ? "manual" : "midnight";
  const result = await runSupplierSendBatch({ source });
  return NextResponse.json({ ok: true, ...result });
}

export function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST with ?secret=<JOB_RUNNER_SECRET> or a signed-in admin session. Sending is gated by the 'Automatic supplier sending' setting.",
  });
}
