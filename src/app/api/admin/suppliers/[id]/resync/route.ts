import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import { getItem } from "@/lib/monday/client";
import { upsertSupplierFromMondayItem } from "@/lib/monday/sync";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await ctx.params;
  const supplier = await db.supplier.findUnique({ where: { id } });
  if (!supplier) return NextResponse.json({ error: "Supplier not found" }, { status: 404 });

  const item = await getItem(supplier.mondayItemId);
  if (!item) {
    // Source row gone from Monday — mark inactive locally (do NOT delete).
    await db.supplier.update({
      where: { id },
      data: { active: false, lastSyncedAt: new Date() },
    });
    return NextResponse.json({ ok: true, deactivated: true });
  }

  await upsertSupplierFromMondayItem(item);
  return NextResponse.json({ ok: true });
}
