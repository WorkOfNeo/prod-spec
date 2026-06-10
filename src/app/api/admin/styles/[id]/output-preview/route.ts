import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { getVariant } from "@/lib/pdf/template-registry";
import { applyFieldOverrides } from "@/lib/pdf/pins";
import { loadStyleRenderContext } from "@/lib/styles/render-context";

export const runtime = "nodejs";

// Live output preview for ONE configured output of ONE style — the HTML the
// runner would render right now, from the style's CURRENT data (same shared
// assembly: src/lib/styles/render-context.ts, including per-output pins).
// No Puppeteer here: the client shows the HTML in a scaled iframe; the true
// PDF stays one click away on the last generated asset.
//
//   GET /api/admin/styles/<id>/output-preview?variantKey=care-label-02
//
// Static-pdf passthrough variants have no live HTML — the artifact is the
// committed artwork. They return 409 + JSON so the card can say so instead
// of presenting a reference drawing as "the print".
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const variantKey = req.nextUrl.searchParams.get("variantKey");
  if (!variantKey) return NextResponse.json({ error: "variantKey required" }, { status: 400 });

  // Multi-document assets link with "<key>#<suffix>" — resolve the base.
  const baseKey = variantKey.split("#")[0];
  const variant = getVariant(baseKey);
  if (!variant) return NextResponse.json({ error: "Unknown variant" }, { status: 404 });

  const context = await loadStyleRenderContext(id);
  if (!context) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  const output = context.outputs.find((o) => o.variantKey === baseKey);
  if (!output) {
    return NextResponse.json(
      { error: "Output not configured on this style's ProdSpec" },
      { status: 404 },
    );
  }

  if (variant.staticPdf) {
    return NextResponse.json(
      {
        staticPdf: true,
        message: "Static artwork passthrough — the output is the committed source PDF.",
      },
      { status: 409 },
    );
  }

  try {
    const renderStyle = applyFieldOverrides(context.styleData, output.fieldOverrides);
    const html = await variant.render(renderStyle, {
      widthMm: output.widthMm,
      heightMm: output.heightMm,
    });
    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Live data — never cache; the whole point is "what would print NOW".
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Render failed" },
      { status: 500 },
    );
  }
}
