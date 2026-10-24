import { NextResponse, type NextRequest } from "next/server";
import { getRevision, type RevisionRow } from "@/lib/output-layouts/revisions";
import { describeLayoutChanges, type LayoutChange } from "@/lib/output-layouts/ops";
import type { LayoutDef } from "@/lib/output-layouts/schema";
import { gateRevisionRoute } from "@/lib/output-layouts/revision-http";

export const runtime = "nodejs";

// One revision in full: { revision, changes }. `revision` carries both
// definitions (proposed/published + what was live when it was made);
// `changes` is the plain-English diff between them, base → definition, as the
// History panel's "Compare" lists it. ADMIN only; 404 while
// CHANGE_REQUESTS_ENABLED is off.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ revisionId: string }> }) {
  const gate = await gateRevisionRoute();
  if (!gate.ok) return gate.response;

  const { revisionId } = await ctx.params;
  const revision = await getRevision(revisionId);
  if (!revision) return NextResponse.json({ error: "Revision not found" }, { status: 404 });

  return NextResponse.json({ revision, changes: changesOf(revision) });
}

// Both sides are real layouts in practice (a draft is schema-checked on the
// way in; the base is what was live). describeLayoutChanges tolerates legacy
// shapes; a definition too broken even for that answers `changes: null`
// ("couldn't compare") rather than an empty list, which would read as "no
// changes".
function changesOf(revision: RevisionRow): LayoutChange[] | null {
  try {
    return describeLayoutChanges(revision.baseDefinition as LayoutDef, revision.definition as LayoutDef);
  } catch {
    return null;
  }
}
