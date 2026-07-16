import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { getGenerationQueue, getGenerationThroughput } from "@/lib/dashboard/style-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Poll target for the Style Dashboard's top band — the live generation queue
// (what's in flight + how long) and the 1h/24h/7d throughput. ADMIN-only, same
// gate as the page (a REVIEWER can't watch the queue).
export async function GET() {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const [queue, throughput] = await Promise.all([getGenerationQueue(), getGenerationThroughput()]);
  return NextResponse.json({ queue, throughput });
}
