import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { ImpactTooLargeError, impactForRevision } from "@/lib/change-requests/impact";
import { RevisionNotFoundError } from "@/lib/output-layouts/revisions";

export const runtime = "nodejs";
// Two renders per style for up to IMPACT_STYLE_LIMIT styles.
export const maxDuration = 120;

// The impact list of a layout revision: every document its definition would
// change against the live layout, with review and delivery state (design
// §5.4). ADMIN only. Read-only apart from caching the summary on the change
// request output whose current draft this is. 404 while the feature flag is
// off, so the route doesn't exist until change requests are switched on.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ revisionId: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { revisionId } = await ctx.params;
  try {
    const summary = await impactForRevision(revisionId);
    return NextResponse.json(summary, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof RevisionNotFoundError || err instanceof ImpactTooLargeError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}
