import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

const VALID_STATUSES = ["NEW", "REVIEWED"] as const;
type ComboStatusValue = (typeof VALID_STATUSES)[number];

// Flip a combo's review status from the /combos dashboard. REVIEWED stamps
// reviewedAt (the admin gave it a first look / built the ProdSpec); moving it
// back to NEW clears that stamp.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const status = (body as { status?: unknown }).status;
  if (typeof status !== "string" || !VALID_STATUSES.includes(status as ComboStatusValue)) {
    return NextResponse.json({ error: "status must be NEW or REVIEWED" }, { status: 400 });
  }

  // updateMany so a stale/missing id is a clean 404, not a thrown P2025.
  const updated = await db.customerBusinessAreaCombo.updateMany({
    where: { id },
    data: {
      status: status as ComboStatusValue,
      reviewedAt: status === "REVIEWED" ? new Date() : null,
    },
  });
  if (updated.count === 0) {
    return NextResponse.json({ error: "Combo not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, status });
}
