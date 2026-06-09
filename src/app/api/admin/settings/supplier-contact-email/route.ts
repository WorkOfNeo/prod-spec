import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";
import {
  getSupplierContactEmailColumn,
  setSupplierContactEmailColumn,
} from "@/lib/settings/app-settings";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  return NextResponse.json({ columnId: await getSupplierContactEmailColumn() });
}

// Set the Monday Suppliers-board column ID used for the supplier contact
// person's email (CC on the approval email). ADMIN only.
export async function PATCH(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const columnId = (body as { columnId?: unknown })?.columnId;
  if (typeof columnId !== "string") {
    return NextResponse.json({ error: "Body must be { columnId: string }" }, { status: 400 });
  }

  await setSupplierContactEmailColumn(columnId);
  await db.log.create({
    data: {
      level: "INFO",
      message: `supplier contact-email column set to "${columnId.trim() || "(cleared)"}" by user ${auth.userId}`,
    },
  });

  return NextResponse.json({ ok: true, columnId: columnId.trim() });
}
