import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requireRole } from "@/lib/auth-server";
import {
  resetCapture,
  resetPasswordRedirectTo,
  type ResetCapture,
} from "@/lib/password-reset";

export const runtime = "nodejs";

// Admin-sent password reset — the "they've lost their password and can't
// get in to ask for one" path. Deliberately routed through better-auth's
// own /request-password-reset rather than minting a token here, so the
// admin-sent link obeys exactly the same single-use + TTL rules as a
// self-service one. The admin never sees or sets the password.
//
// The endpoint returns only a neutral "if this email exists…" message, so
// the EmailOutcome (for the simulation dialog) and the link (for copy-paste
// when email is down) are captured out of the sendResetPassword hook — see
// the ResetCapture note in src/lib/password-reset.ts.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const adminAuth = await requireRole(["ADMIN"]);
  if (!adminAuth.ok) {
    return NextResponse.json({ error: adminAuth.error }, { status: adminAuth.status });
  }

  const { id } = await ctx.params;
  const user = await db.user.findUnique({ where: { id }, select: { email: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const capture: ResetCapture = {};
  try {
    await resetCapture.run(capture, () =>
      auth.api.requestPasswordReset({
        body: { email: user.email, redirectTo: resetPasswordRedirectTo() },
      }),
    );
  } catch (err) {
    return NextResponse.json(
      { error: `Could not create a reset link: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  // The hook never ran → no token was minted (better-auth answers the same
  // way for an unknown address). Don't report success for an email that
  // isn't going anywhere.
  if (!capture.outcome || !capture.link) {
    return NextResponse.json(
      { error: "No reset link could be created for this account." },
      { status: 409 },
    );
  }

  await db.log.create({
    data: {
      level: "INFO",
      message: `password reset link for ${user.email} sent by user ${adminAuth.userId} — email ${capture.outcome.status}`,
    },
  });

  return NextResponse.json({ ok: true, link: capture.link, email: capture.outcome });
}
