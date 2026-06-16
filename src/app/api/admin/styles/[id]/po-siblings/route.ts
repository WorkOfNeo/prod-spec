import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { loadStyleRenderContext } from "@/lib/styles/render-context";

export const runtime = "nodejs";

// Candidate OTHER styles on the same PO for the "Custom Carton Marking"
// picker — the pre-fetched, projected sibling POOL that buildStyleData
// already assembles (StyleData.siblings). The carton dialog calls this on
// open to populate its multiselect; the chosen ids are POSTed back to
// /carton-prints (one-off) and/or persisted as a slot count on the
// ProdSpec output (/custom-carton-marking).
//
//   GET /api/admin/styles/<id>/po-siblings?variantKey=layout:<id>
//   → { siblings: [{ id, styleNumber, styleName, colourName, description }],
//       permanent: { enabled, slots } | null }   // for the passed output
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

  // The permanent (prod-spec level) slot policy for the requested output,
  // so the dialog can pre-select the inherited siblings.
  const variantKey = req.nextUrl.searchParams.get("variantKey")?.split("#")[0];
  const output = variantKey ? context.outputs.find((o) => o.variantKey === variantKey) : undefined;
  const permanent = output?.customCartonMarking ?? null;

  return NextResponse.json(
    { siblings, permanent },
    { headers: { "Cache-Control": "no-store" } },
  );
}
