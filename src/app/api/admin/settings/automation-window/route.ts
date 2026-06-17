import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { setAutomationWindowDays } from "@/lib/settings/app-settings";

export const runtime = "nodejs";

// Set the automation recent-window (days). ADMIN only — it changes how much of
// the backlog auto-scrape + the generation sweep will touch. 0 = no window.
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const days = (body as { days?: unknown })?.days;
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) {
    return NextResponse.json({ error: "Body must be { days: number >= 0 }" }, { status: 400 });
  }

  const value = Math.floor(days);
  await setAutomationWindowDays(value);
  await db.log.create({
    data: {
      level: "INFO",
      message: `automation recent-window set to ${value} day(s) by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true, days: value });
}
