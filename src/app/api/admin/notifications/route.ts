// GET /api/admin/notifications
//
// The current user's feed — not dismissed, newest first, capped. The
// dashboard renders the feed server-side; this endpoint exists for client
// refreshes and a future bell without another schema pass.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const notifications = await db.userNotification.findMany({
    // Open feed only: dismissed rows are hidden by the user, resolved rows
    // point at work that already settled — neither should summon anyone.
    where: { userId: auth.userId, dismissedAt: null, resolvedAt: null },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json({
    notifications,
    unread: notifications.filter((n) => n.readAt === null).length,
  });
}
