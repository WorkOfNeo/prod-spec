import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { MAX_PUSH_ATTEMPTS } from "@/lib/sharepoint/push-queued-to-supplier";

export const runtime = "nodejs";

// Reset the "gave up" (floated) upload rows so the next sweep retries them —
// the manual counterpart of the EAN float's per-row re-trigger. ADMIN only.
// Resets pushAttempts + flips FAILED → PENDING; the recurring sweep (or the
// "Upload to SharePoint now" button) does the actual pushing.
export async function POST() {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const res = await db.supplierSendQueueItem.updateMany({
    where: {
      sentAt: null,
      sharePointStatus: "FAILED",
      pushAttempts: { gte: MAX_PUSH_ATTEMPTS },
    },
    data: { sharePointStatus: "PENDING", pushAttempts: 0 },
  });

  return NextResponse.json({ ok: true, reset: res.count });
}
