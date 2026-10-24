import { NextResponse, type NextRequest } from "next/server";
import { getSessionWithRole } from "@/lib/auth-server";
import { isAdmin } from "@/lib/roles";
import { changeRequestsEnabled } from "@/lib/change-requests/flags";
import {
  ProofNotFoundError,
  ProofRenderError,
  parseProofQuery,
  renderProof,
} from "@/lib/change-requests/proofs";

export const runtime = "nodejs";
// A cold proof launches the shared Chromium and renders the style's output
// before the screenshot; well inside a minute, but not inside the default.
export const maxDuration = 60;

// One before/after proof picture of a layout draft (design §5.5).
//
//   GET ?styleId=<id>&side=before|after[&doc=0][&suffix=<doc suffix>]
//
// before = the layout as it prints today, after = the draft — the same
// faithful per-output render the runner uses, first page as PNG. Read-only:
// nothing is written, so a reviewer can reload it as often as they like.
// ADMIN only, like every change-request review surface; 404 with the feature
// flag off. Private cache: the picture is a style's real data.
export async function GET(req: NextRequest, ctx: { params: Promise<{ revisionId: string }> }) {
  if (!changeRequestsEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(role)) return NextResponse.json({ error: "Requires role: ADMIN" }, { status: 403 });

  const { revisionId } = await ctx.params;
  const query = parseProofQuery(req.nextUrl.searchParams);
  if (!query.ok) return NextResponse.json({ error: query.error }, { status: 400 });

  try {
    const proof = await renderProof({ revisionId, ...query.value });
    return new NextResponse(new Uint8Array(proof.png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=300",
        // So the review screen can label the picture without a second call.
        "X-Proof-Doc": String(proof.doc),
        "X-Proof-Size-Mm": `${proof.widthMm}x${proof.heightMm}`,
        ...(proof.suffix !== null ? { "X-Proof-Suffix": encodeURIComponent(proof.suffix) } : {}),
      },
    });
  } catch (err) {
    if (err instanceof ProofNotFoundError || err instanceof ProofRenderError) {
      return NextResponse.json({ error: err.message }, { status: err.httpStatus });
    }
    throw err;
  }
}
