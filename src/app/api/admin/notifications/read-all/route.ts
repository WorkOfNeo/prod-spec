// POST /api/admin/notifications/read-all
//
// Stamp readAt on every unread, undismissed notification of the current
// user. The feed shows unread rows bold; this clears the emphasis.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function POST() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { count } = await db.userNotification.updateMany({
    where: { userId: auth.userId, readAt: null, dismissedAt: null },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true, marked: count });
}
