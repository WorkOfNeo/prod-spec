import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { UserRole } from "@/generated/prisma/enums";
import {
  buildInviteLink,
  createInvite,
  isMissingInvitesTable,
} from "@/lib/invites/invites";
import { sendInviteEmail } from "@/lib/invites/email";

export const runtime = "nodejs";

// Create an invite: { email, role, send? }. ADMIN only. Any still-pending
// invite for the same email is superseded (revoked) by the new one. With
// send=true the invitation email goes out through the flag-aware
// dispatcher and the outcome rides back so the UI can pop the simulation
// dialog while RESEND_EMAILS is off.
export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { email, role, send } = (body ?? {}) as {
    email?: unknown;
    role?: unknown;
    send?: unknown;
  };

  if (typeof email !== "string" || !/^\S+@\S+\.\S+$/.test(email.trim())) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }
  const normalized = email.trim().toLowerCase();
  const inviteRole: UserRole =
    role === "ADMIN" ? UserRole.ADMIN : UserRole.REVIEWER;

  const existing = await db.user.findUnique({ where: { email: normalized }, select: { id: true } });
  if (existing) {
    return NextResponse.json(
      { error: "That email already has an account — they can just sign in." },
      { status: 409 },
    );
  }

  try {
    const invite = await createInvite({
      email: normalized,
      role: inviteRole,
      invitedById: auth.userId,
    });
    const link = buildInviteLink(invite.token);

    let emailOutcome = null;
    if (send === true) {
      const inviter = await db.user.findUnique({
        where: { id: auth.userId },
        select: { name: true },
      });
      emailOutcome = await sendInviteEmail(invite, inviter?.name);
    }

    await db.log.create({
      data: {
        level: "INFO",
        message: `invite created for ${invite.email} (${invite.role}) by user ${auth.userId}${send === true ? ` — email ${emailOutcome?.status}` : ""}`,
      },
    });

    return NextResponse.json({
      ok: true,
      invite: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt },
      link,
      email: emailOutcome,
    });
  } catch (err) {
    if (isMissingInvitesTable(err)) {
      return NextResponse.json(
        { error: "Invites table is not migrated yet — run npm run db:deploy first." },
        { status: 503 },
      );
    }
    throw err;
  }
}
