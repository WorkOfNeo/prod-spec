import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { loadStyleRenderContext } from "@/lib/styles/render-context";

export const runtime = "nodejs";

// Candidate OTHER styles on the same PO for the "Custom Carton Marking"
// picker — the pre-fetched, projected sibling POOL that loadStyleRenderContext
// assembles (StyleData.siblings). The carton dialog calls this on open to
// populate its multiselect; the chosen ids are POSTed back to /carton-prints
// for a one-off multi-style print. There is NO standing config — multi-style
// is manual-only.
//
//   GET /api/admin/styles/<id>/po-siblings
//   → { siblings: [{ id, styleNumber, styleName, colourName, description }] }
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const context = await loadStyleRenderContext(id);
  if (!context) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  const siblings = (context.styleData.siblings ?? []).map((s) => ({
    id: s.id,
    styleNumber: s.styleNumber,
    styleName: s.styleName,
    colourName: s.colourName,
    description: s.description,
  }));

  return NextResponse.json({ siblings }, { headers: { "Cache-Control": "no-store" } });
}
