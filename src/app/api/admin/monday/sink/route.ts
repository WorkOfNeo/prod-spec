import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { sinkBoard } from "@/lib/monday/sink";

export const runtime = "nodejs";
// Sinking a full board (columns + every item + dropdown labels) can take a
// minute or two on large boards. Match the existing sync routes' budget.
export const maxDuration = 300;

// POST /api/admin/monday/sink?boardId=<id>
// Drops a full snapshot of one Monday board into the ghost tables. Idempotent.
// Returns the SinkResult so the UI can show synced counts inline.
export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const boardId = req.nextUrl.searchParams.get("boardId");
  if (!boardId) {
    return NextResponse.json(
      { error: "boardId query param required (e.g. ?boardId=6979419195)" },
      { status: 400 },
    );
  }

  try {
    const result = await sinkBoard(boardId);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
