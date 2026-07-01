import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  getSupplierBatchSendEnabled,
  setSupplierBatchSendEnabled,
} from "@/lib/settings/app-settings";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ enabled: await getSupplierBatchSendEnabled() });
}

// Flip the nightly supplier-send master switch. ADMIN only — when ON, approved
// outputs push to SharePoint and the midnight cron emails suppliers.
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

  await setSupplierBatchSendEnabled(enabled);
  await db.log.create({
    data: {
      level: "INFO",
      message: `supplier batch send ${enabled ? "ENABLED" : "DISABLED"} by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true, enabled });
}
