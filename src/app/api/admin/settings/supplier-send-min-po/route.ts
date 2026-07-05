import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  getGenerationMinPo,
  getSupplierSendMinPo,
  getSupplierSendMinPoExplicit,
  setSupplierSendMinPo,
} from "@/lib/settings/app-settings";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const [explicit, effective, generation] = await Promise.all([
    getSupplierSendMinPoExplicit(),
    getSupplierSendMinPo(),
    getGenerationMinPo(),
  ]);
  return NextResponse.json({ explicit, effective, generation });
}

// Set / clear the supplier-send backfill PO cutoff (Option A). ADMIN only.
// Body: { cutoff: number | null } — null clears (falls back to the generation
// cutoff; with the whole chain unset the backfill reconciler stays idle).
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const cutoff = (body as { cutoff?: unknown })?.cutoff;
  if (cutoff !== null && (typeof cutoff !== "number" || !Number.isFinite(cutoff) || cutoff <= 0)) {
    return NextResponse.json({ error: "Body must be { cutoff: positive number | null }" }, { status: 400 });
  }

  await setSupplierSendMinPo(cutoff as number | null);
  await db.log.create({
    data: {
      level: "INFO",
      message: `supplier-send backfill cutoff ${cutoff === null ? "CLEARED" : `set to PO ≥ ${cutoff}`} by user ${auth.userId}`,
    },
  });

  const effective = await getSupplierSendMinPo();
  return NextResponse.json({ ok: true, explicit: cutoff, effective });
}
