import type { NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";

// Cron endpoints accept either:
//   - `?secret=$JOB_RUNNER_SECRET` query param (Railway cron, webhook follow-up)
//   - a signed-in admin session (manual trigger from the admin UI)
// The pattern mirrors src/app/api/jobs/run/route.ts.
export async function isCronAuthorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.JOB_RUNNER_SECRET;
  const provided =
    req.nextUrl.searchParams.get("secret") ?? req.headers.get("x-job-runner-secret");
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
