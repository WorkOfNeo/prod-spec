import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { orEmpty } from "@/lib/change-requests/db-safe";
import { computeImpact, impactForRevision } from "@/lib/change-requests/impact";
import { pickProofsForRevision } from "@/lib/change-requests/proofs";
import { publishErrorResponse } from "@/lib/change-requests/publish-errors";
import { ImpactSummarySchema, type ImpactSummary } from "@/lib/change-requests/types";
import { getRevision } from "@/lib/output-layouts/revisions";
import { parseLayoutDef } from "@/lib/output-layouts/schema";

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
// The impact is the one stored on the change-request output while this
// revision is its current draft (for a published one: the fresh base-vs-
// published list the approval stored); any other revision — an older draft
// picked in the draft selector — gets impactForRevision() against what is
// live now. A published revision with nothing stored compares what was live
// before it with itself published (against the live layout it would show no
// change at all). Each pick's pictures then load from …/proof?styleId=&side=&suffix=.
// Read-only apart from impactForRevision caching on the current draft. ADMIN
// only; 404 while CHANGE_REQUESTS_ENABLED is off.
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
    const impact =
      (output?.currentRevisionId === revision.id ? storedImpact(output.impact) : null) ??
      (revision.status === "PUBLISHED"
        ? await computeImpact({
            layoutId: revision.layoutId,
            proposedDef: parseLayoutDef(revision.definition),
            currentDef: parseLayoutDef(revision.baseDefinition),
          })
        : await impactForRevision(revision.id));
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
