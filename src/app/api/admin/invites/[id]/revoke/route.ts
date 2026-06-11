import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { revokeInvite } from "@/lib/invites/invites";

export const runtime = "nodejs";

// Kill a pending invite — the link stops working immediately. Idempotent
// from the admin's perspective; only a still-pending invite flips.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const invite = await revokeInvite(id);
  if (!invite) {
    return NextResponse.json(
      { error: "This invite was already used or revoked." },
      { status: 409 },
    );
  }

  await db.log.create({
    data: {
      level: "INFO",
      message: `invite for ${invite.email} revoked by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true });
}
