import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { getAutoGenerateEnabled, setAutoGenerateEnabled } from "@/lib/settings/app-settings";

export const runtime = "nodejs";

// Read the current value. The settings page reads server-side, so this is
// here mainly for completeness / external callers.
export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ enabled: await getAutoGenerateEnabled() });
}

// Flip the global auto-generate master switch. ADMIN only — it changes
// pipeline behaviour for the whole instance.
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const enabled = (body as { enabled?: unknown })?.enabled;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "Body must be { enabled: boolean }" }, { status: 400 });
  }

  await setAutoGenerateEnabled(enabled);
  await db.log.create({
    data: {
      level: "INFO",
      message: `auto-generate ${enabled ? "ENABLED" : "DISABLED"} by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true, enabled });
}
