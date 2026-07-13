import { NextResponse, type NextRequest } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { sinkBoard } from "@/lib/monday/sink";
import { syncTranslations } from "@/lib/monday/translations";
import { MONDAY_BOARDS } from "@/lib/monday/boards";
import { autoSyncTranslations } from "@/lib/monday/translations-auto-sync";

export const runtime = "nodejs";
// Sinking the board (every phrase + 27 language columns) then transforming
// can run a minute or two — match the other sync routes' budget.
export const maxDuration = 300;

function hasRunnerSecret(req: NextRequest): boolean {
  const secret = process.env.JOB_RUNNER_SECRET;
  if (!secret) return false;
  return req.nextUrl.searchParams.get("secret") === secret;
}

// POST /api/admin/translations/sync
//
// Two callers:
//   • The Monday Translations-board webhook kicks this with
//     ?secret=JOB_RUNNER_SECRET (no user session). It runs the COALESCED
//     auto-sync so a burst of cell edits doesn't spawn overlapping full board
//     re-sinks — see src/lib/monday/translations-auto-sync.ts.
//   • An admin clicking "Sync from Monday" on /translations. Runs immediately
//     and returns the phrase/language counts the UI shows.
//
// ?transformOnly=true (admin only) skips the Monday fetch and just re-transforms
// whatever is already in the ghost mirror (useful after a TITLE_TO_LANG change).
export async function POST(req: NextRequest) {
  // Internal webhook kick — secret-authed, coalesced background refresh.
  if (hasRunnerSecret(req)) {
    try {
      const outcome = await autoSyncTranslations();
      return NextResponse.json({ ok: true, ...outcome });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 502 });
    }
  }

  // Manual admin sync — unchanged behaviour, runs the full pipeline now.
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const transformOnly = req.nextUrl.searchParams.get("transformOnly") === "true";
  try {
    // freshSince (captured before the sink) puts syncTranslations in reconcile
    // mode so phrases removed on Monday get soft-deactivated. transformOnly has
    // no fresh sink, so it skips reconciliation.
    const freshSince = transformOnly ? undefined : new Date();
    const sink = freshSince ? await sinkBoard(MONDAY_BOARDS.translations) : null;
    const result = await syncTranslations(freshSince ? { freshSince } : undefined);
    return NextResponse.json({ sink, ...result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
