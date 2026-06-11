// GET /api/admin/dashboard/counts
//
// Powers the "My tasks" sidebar badge. badge = reviews waiting on YOU
// (your unfinished ones + the untouched first-review queue). Reviews in
// flight under other users are reported but deliberately not counted —
// they aren't your to-do.
//
// Same derived queries as /dashboard (lib/dashboard/review-tasks.ts), so
// the badge and the page can never disagree. The sidebar polls every 60s,
// mirroring the import notification bell.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { getReviewWork } from "@/lib/dashboard/review-tasks";
import { reviewFollowThroughEnabled } from "@/lib/review-flow/flags";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireRole(["ADMIN", "REVIEWER"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  // Kill switch thrown → permanent zeros (the sidebar link is hidden too;
  // this keeps any stale tab's poller quiet instead of erroring).
  if (!reviewFollowThroughEnabled()) {
    return NextResponse.json({ badge: 0, parts: { mine: 0, queue: 0, others: 0 } });
  }

  const work = await getReviewWork(auth.userId);
  return NextResponse.json({
    badge: work.mine.length + work.untouched.length,
    parts: {
      mine: work.mine.length,
      queue: work.untouched.length,
      others: work.others.length,
    },
  });
}
