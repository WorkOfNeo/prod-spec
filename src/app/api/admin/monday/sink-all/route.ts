import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { sinkAllKnownBoards } from "@/lib/monday/sink";

export const runtime = "nodejs";
export const maxDuration = 300;

// POST /api/admin/monday/sink-all
// Sinks every board listed in MONDAY_BOARDS in declaration order.
// Boards that fail end up in `failed[]`; the run keeps going so a
// single broken board doesn't block the others.
export async function POST() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const result = await sinkAllKnownBoards();
  return NextResponse.json(result);
}
