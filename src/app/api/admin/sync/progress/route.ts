// GET /api/admin/sync/progress?kind=STYLES (or CUSTOMERS / SUPPLIERS /
// BUSINESS_AREAS / ALL)
//
// Returns the latest SyncJob row for the requested kind. The Fill panel
// polls this every ~1 s while a Fill button is busy so the user can see
// "x of y items processed" without waiting for the blocking POST to
// finish. Cheap: indexed lookup keyed on `kind` + `startedAt DESC`.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-server";

export const runtime = "nodejs";

const KIND_SCHEMA = z.enum([
  "CUSTOMERS",
  "SUPPLIERS",
  "BUSINESS_AREAS",
  "STYLES",
  "ALL",
  "SINK_ALL",
  "SINK_BOARD",
]);

export async function GET(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const raw = req.nextUrl.searchParams.get("kind");
  const parsed = KIND_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid kind", allowed: KIND_SCHEMA.options },
      { status: 400 },
    );
  }

  const job = await db.syncJob.findFirst({
    where: { kind: parsed.data },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      kind: true,
      status: true,
      itemsTotal: true,
      itemsSynced: true,
      itemsFailed: true,
      itemsSkipped: true,
      startedAt: true,
      finishedAt: true,
      error: true,
    },
  });

  return NextResponse.json({ job });
}
