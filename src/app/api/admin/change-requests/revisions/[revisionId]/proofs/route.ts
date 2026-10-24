import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { orEmpty } from "@/lib/change-requests/db-safe";
import { impactForRevision } from "@/lib/change-requests/impact";
import { pickProofsForRevision } from "@/lib/change-requests/proofs";
import { publishErrorResponse } from "@/lib/change-requests/publish-errors";
import { ImpactSummarySchema, type ImpactSummary } from "@/lib/change-requests/types";
import { getRevision } from "@/lib/output-layouts/revisions";

export const runtime = "nodejs";
// A draft with no stored impact gets one computed here (two renders per
// style), plus field values for the branch picks.
export const maxDuration = 120;

// =====================================================
// GET /api/admin/change-requests/revisions/[revisionId]/proofs — which
// before/after pictures the review screen shows for a draft, and the impact
// they were picked from:
//
//   { picks: ProofPick[], impactCounts, impact }
//
// The stored impact on the change-request output is trusted only while this
// revision is its current one AND an impact is stored (a new revision clears
// it; for a published one it is the fresh base-vs-published list the
// approval stored). Anything else — an older draft picked in the draft
// selector, a current draft with nothing stored yet — gets
// impactForRevision(): a draft against what is live now (cached when it is
// the current draft), a published revision as what was live before it
// against itself published. Each pick's pictures then load from
// …/proof?styleId=&side=&suffix=. Read-only apart from impactForRevision
// caching on the current draft. ADMIN only; 404 while CHANGE_REQUESTS_ENABLED
// is off.
// =====================================================

function storedImpact(raw: unknown): ImpactSummary | null {
  if (raw == null) return null;
  const parsed = ImpactSummarySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ revisionId: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { revisionId } = await ctx.params;
  const revision = await getRevision(revisionId);
  if (!revision) return NextResponse.json({ error: "Revision not found" }, { status: 404 });

  const output = revision.changeRequestOutputId
    ? await orEmpty(
        db.changeRequestOutput.findUnique({
          where: { id: revision.changeRequestOutputId },
          select: { styleId: true, currentRevisionId: true, impact: true },
        }),
        null,
      )
    : null;

  try {
    const stored =
      output && output.currentRevisionId === revision.id && output.impact != null ? storedImpact(output.impact) : null;
    const impact = stored ?? (await impactForRevision(revision.id));
    const picks = await pickProofsForRevision({ revisionId: revision.id, impact, focusStyleId: output?.styleId ?? null });
    return NextResponse.json(
      { picks, impactCounts: impact.counts, impact },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    const mapped = publishErrorResponse(err);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    throw err;
  }
}
