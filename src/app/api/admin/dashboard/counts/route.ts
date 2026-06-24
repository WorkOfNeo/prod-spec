// GET /api/admin/dashboard/counts
//
// Powers the "My tasks" sidebar badge. badge = reviews YOU'VE STARTED and
// not yet finished (claimed, or ≥1 decision made, still pending). The
// untouched first-review queue and reviews in flight under other users are
// still reported in `parts` for context, but deliberately NOT counted —
// neither is your committed to-do. The global queue lives on /reviews.
//
// Same per-style bucketing as /dashboard (lib/dashboard/review-tasks.ts), so
// the badge and the page can never disagree. Uses getReviewCounts — the
// lightweight (one-query, no cross-job output rollup) sibling of getReviewWork
// — because the sidebar polls every 60s and only needs the counts.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth-server";
import { getReviewCounts } from "@/lib/dashboard/review-tasks";
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

  const counts = await getReviewCounts(auth.userId);
  return NextResponse.json({
    badge: counts.mine,
    parts: {
      mine: counts.mine,
      queue: counts.untouched,
      others: counts.others,
    },
  });
}
