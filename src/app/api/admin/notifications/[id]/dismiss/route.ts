// POST /api/admin/notifications/[id]/dismiss
//
// Hide one feed row. Ownership-checked: users can only dismiss their own.

import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const { count } = await db.userNotification.updateMany({
    where: { id, userId: auth.userId, dismissedAt: null },
    data: { dismissedAt: new Date() },
  });
  if (count === 0) return NextResponse.json({ error: "Notification not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
