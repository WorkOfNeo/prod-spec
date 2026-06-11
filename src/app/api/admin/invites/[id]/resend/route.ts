import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { buildInviteLink, extendInvite } from "@/lib/invites/invites";
import { sendInviteEmail } from "@/lib/invites/email";

export const runtime = "nodejs";

// Re-send an invitation: gives the SAME link a fresh validity window
// (covers the common "it expired before they clicked" case) and emails it
// again. Used and revoked invites stay dead — create a new invite instead.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const invite = await extendInvite(id);
  if (!invite) {
    return NextResponse.json(
      { error: "This invite was already used or revoked — create a new one instead." },
      { status: 409 },
    );
  }

  const inviter = await db.user.findUnique({
    where: { id: auth.userId },
    select: { name: true },
  });
  const emailOutcome = await sendInviteEmail(invite, inviter?.name);

  await db.log.create({
    data: {
      level: "INFO",
      message: `invite for ${invite.email} resent by user ${auth.userId} — email ${emailOutcome.status}`,
    },
  });

  return NextResponse.json({
    ok: true,
    invite: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt },
    link: buildInviteLink(invite.token),
    email: emailOutcome,
  });
}
