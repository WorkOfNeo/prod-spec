import { NextResponse, type NextRequest } from "next/server";
import { runPendingJobs } from "@/lib/queue/runner";
import { getServerSession } from "@/lib/auth-server";

export const runtime = "nodejs";
export const maxDuration = 300;

// Accepts requests from:
//  - The webhook receiver firing inline after enqueue (sends ?secret=)
//  - Railway cron (sends ?secret=)
//  - The admin "Run now" button (signed-in session, no secret needed)
async function isAuthorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.JOB_RUNNER_SECRET;
  const provided = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-job-runner-secret");
  if (secret && provided && timingSafeEqual(secret, provided)) return true;

  const session = await getServerSession();
  return session !== null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "5");
  const summary = await runPendingJobs(Math.min(Math.max(limit, 1), 20));
  return NextResponse.json(summary);
}

export function GET() {
  return NextResponse.json({ ok: true, hint: "POST with ?secret=<JOB_RUNNER_SECRET> or signed-in session" });
}
