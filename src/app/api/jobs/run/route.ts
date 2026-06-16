import { NextResponse, type NextRequest } from "next/server";
import { runPendingJobs } from "@/lib/queue/runner";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";

export const runtime = "nodejs";
export const maxDuration = 300;

type Authz = { ok: true } | { ok: false; status: 401 | 403; error: string };

// Accepts requests from:
//  - The webhook receiver firing inline after enqueue (sends ?secret=)
//  - Railway cron (sends ?secret=)
//  - The admin "Run now" button (signed-in ADMIN session, no secret needed)
// The secret (automation) path is role-agnostic; the interactive session
// path is ADMIN-only — a signed-in REVIEWER must not be able to drain the
// generation queue by hitting this endpoint directly.
async function authorize(req: NextRequest): Promise<Authz> {
  const secret = process.env.JOB_RUNNER_SECRET;
  const provided = req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-job-runner-secret");
  if (secret && provided && timingSafeEqual(secret, provided)) return { ok: true };

  const { session, role } = await getSessionWithRole();
  if (!session) return { ok: false, status: 401, error: "Unauthorized" };
  if (!isAdmin(role)) return { ok: false, status: 403, error: "Requires role: ADMIN" };
  return { ok: true };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function POST(req: NextRequest) {
  const authz = await authorize(req);
  if (!authz.ok) {
    return NextResponse.json({ error: authz.error }, { status: authz.status });
  }
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "5");
  const summary = await runPendingJobs(Math.min(Math.max(limit, 1), 20));
  return NextResponse.json(summary);
}

export function GET() {
  return NextResponse.json({ ok: true, hint: "POST with ?secret=<JOB_RUNNER_SECRET> or signed-in session" });
}
