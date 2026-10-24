import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import { describeLayoutChanges } from "@/lib/output-layouts/ops";
import { getRevision } from "@/lib/output-layouts/revisions";
import { parseLayoutDef } from "@/lib/output-layouts/schema";

export const runtime = "nodejs";

// =====================================================
// GET /api/admin/change-requests/revisions/[revisionId]/diff — what a draft
// changes in the layout definition, for the review screen's "Layout changes":
//
//   { changes: LayoutChange[], before, after }
//
// `changes` is describeLayoutChanges(base, definition) — the same plain-words
// diff the agent and the learning signals use — against what was live when
// the draft was made (its baseDefinition), so the list stays the draft's own
// changes even after the layout moves on. `before` / `after` are the raw
// definitions for the collapsible JSON view. Read-only. ADMIN only; 404 while
// CHANGE_REQUESTS_ENABLED is off.
// =====================================================

export async function GET(_req: NextRequest, ctx: { params: Promise<{ revisionId: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { revisionId } = await ctx.params;
  const revision = await getRevision(revisionId);
  if (!revision) return NextResponse.json({ error: "Revision not found" }, { status: 404 });

  let changes;
  try {
    changes = describeLayoutChanges(parseLayoutDef(revision.baseDefinition), parseLayoutDef(revision.definition));
  } catch (err) {
    return NextResponse.json(
      { error: `The definitions can't be compared: ${err instanceof Error ? err.message : String(err)}` },
      { status: 422 },
    );
  }
  return NextResponse.json(
    { changes, before: revision.baseDefinition, after: revision.definition },
    { headers: { "cache-control": "no-store" } },
  );
}
