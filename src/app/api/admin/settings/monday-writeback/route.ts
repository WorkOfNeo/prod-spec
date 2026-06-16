import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  getMondayWriteBackEnabled,
  setMondayWriteBackEnabled,
} from "@/lib/settings/app-settings";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ enabled: await getMondayWriteBackEnabled() });
}

// Flip the global Monday write-back master switch. ADMIN only — it controls
// whether the app writes statuses back to Monday for the whole instance.
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

  await setMondayWriteBackEnabled(enabled);
  // Recorded as a writeback-log line too so the audit trail in the Webhooks
  // tab shows when the switch itself was flipped.
  await db.log.create({
    data: {
      level: "INFO",
      message: `monday.writeback SWITCH ${enabled ? "ENABLED" : "DISABLED"} by user ${auth.userId}`,
      payload: { kind: "writeback-switch", enabled, userId: auth.userId },
    },
  });

  return NextResponse.json({ ok: true, enabled });
}
