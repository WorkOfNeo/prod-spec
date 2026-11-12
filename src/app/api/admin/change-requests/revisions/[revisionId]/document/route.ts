import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import {
  ProofNotFoundError,
  ProofRenderError,
  parseProofQuery,
  renderRevisionDocument,
} from "@/lib/change-requests/proofs";

export const runtime = "nodejs";

// One whole document of a layout draft, for the draft walkthrough: the same
// faithful per-output render as the proof pictures, but as HTML with every
// page, so a person can step through the draft on any style the change
// touches before approving it.
//
//   GET ?styleId=<id>&side=before|after[&doc=0][&suffix=<doc suffix>]
//     → { html, widthMm, heightMm, suffix, doc, documents: [{ suffix }] }
//
// before = what prints today, after = the draft (proofs.ts). Read-only.
// ADMIN only, like every change-request review surface; 404 with the feature
// flag off. Not cached: the HTML is a style's live data.
export async function GET(req: NextRequest, ctx: { params: Promise<{ revisionId: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { revisionId } = await ctx.params;
  const query = parseProofQuery(req.nextUrl.searchParams);
  if (!query.ok) return NextResponse.json({ error: query.error }, { status: 400 });

  try {
    const document = await renderRevisionDocument({ revisionId, ...query.value });
    return NextResponse.json(document, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ProofNotFoundError || err instanceof ProofRenderError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}
