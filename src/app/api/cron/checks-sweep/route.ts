import { NextResponse, type NextRequest } from "next/server";
import { isCronAuthorized } from "@/lib/cron/auth";
import { resumeStalledSweep } from "@/lib/checks/sweep";

export const runtime = "nodejs";
export const maxDuration = 60;

// =====================================================
// Resume an abandoned all-PO folder sweep.
//
// A sweep is about an hour of Graph calls, and a deploy in the middle of it
// kills the process holding it. The run itself survives — every folder checked
// is already a row — but nothing restarts the loop. This is that restart: it
// takes over a run whose heartbeat has gone cold and picks up the folders still
// marked pending.
//
// It deliberately does NOT start anything. A sweep is a person's decision (it
// is the app's heaviest read of SharePoint), so with nothing abandoned this is
// a no-op. Scheduling it in Railway makes recovery from a deploy automatic;
// without the schedule the Resume button on /checks/sweep does the same thing
// by hand, which is why nothing depends on it existing.
// =====================================================

export async function POST(req: NextRequest) {
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { resumed } = await resumeStalledSweep();
    return NextResponse.json({ ok: true, resumed });
  } catch (err) {
    console.error("[cron/checks-sweep] resume failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Resume failed" },
      { status: 500 },
    );
  }
}
