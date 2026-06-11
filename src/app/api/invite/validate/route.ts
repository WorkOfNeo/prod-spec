import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { checkInviteToken } from "@/lib/invites/invites";

export const runtime = "nodejs";

// PUBLIC — the signup page calls this before the visitor types anything,
// to pre-fill + lock the email on a good link or show a friendly dead-end
// on a bad one. Enforcement does NOT live here: the signup hook in
// src/lib/auth.ts re-runs the same checkInviteToken on submit. Leaks
// nothing about existing accounts — only whether THIS token is live, plus
// whether the instance is still unclaimed (bootstrap → first-admin form).
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");

  let bootstrap = false;
  try {
    bootstrap = (await db.user.count()) === 0;
  } catch {
    // DB unreachable — report the closed default; signup stays locked.
  }

  const check = await checkInviteToken(token);
  if (!check.valid) {
    return NextResponse.json({ valid: false, reason: check.reason, bootstrap });
  }
  return NextResponse.json({
    valid: true,
    email: check.invite.email,
    role: check.invite.role,
    bootstrap,
  });
}
