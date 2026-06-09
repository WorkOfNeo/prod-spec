import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { sinkBoard } from "@/lib/monday/sink";
import { syncTranslations } from "@/lib/monday/translations";
import { MONDAY_BOARDS } from "@/lib/monday/boards";

export const runtime = "nodejs";
// Sinking the board (every phrase + 27 language columns) then transforming
// can run a minute or two — match the other sync routes' budget.
export const maxDuration = 300;

// POST /api/admin/translations/sync
// Sinks the Translations board into the ghost tables, then transforms the
// rows into the Translation dictionary. One click = a fresh dictionary.
//
// ?transformOnly=true skips the Monday fetch and just re-transforms whatever
// is already in the ghost mirror (useful after a TITLE_TO_LANG change).
export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const transformOnly = req.nextUrl.searchParams.get("transformOnly") === "true";
  try {
    const sink = transformOnly ? null : await sinkBoard(MONDAY_BOARDS.translations);
    const result = await syncTranslations();
    return NextResponse.json({ sink, ...result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
