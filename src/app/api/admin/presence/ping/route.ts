import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

// Presence heartbeat — the admin-layout client beacon POSTs here every ~60s
// while a tab is open. Upserts the caller's lastSeenAt; that single timestamp
// backs "online now" / "last online" / online count on the /admin Users tab.
// Best-effort: swallow failures (incl. the table not being deployed yet) so a
// heartbeat can never surface an error. Both ADMIN and REVIEWER are tracked.
export async function POST() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const now = new Date();
    await db.userPresence.upsert({
      where: { userId: auth.userId },
      create: { userId: auth.userId, lastSeenAt: now },
      update: { lastSeenAt: now },
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, logged: false });
  }
}
