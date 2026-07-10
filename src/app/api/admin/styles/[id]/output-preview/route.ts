import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "@/lib/auth-server";
import { getVariant } from "@/lib/pdf/template-registry";
import { applyFieldOverrides, withSelectedSiblings } from "@/lib/pdf/pins";
import {
  ignoreBaseKey,
  loadStyleFieldValues,
  mergeFieldOverrides,
} from "@/lib/outputs/output-field-values";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { effectiveOutputDims, loadInfoAreaSizeMap } from "@/lib/prod-spec/info-area";

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

  // Optional "preview as carton N of M" — binds StyleData.cartonSerial so
  // {{cartonNo}}/{{cartonTotal}} resolve, used by the Carton-numbers dialog.
  const cartonNo = Number(req.nextUrl.searchParams.get("cartonNo"));
  const cartonTotal = Number(req.nextUrl.searchParams.get("cartonTotal"));
  const cartonSerial =
    Number.isInteger(cartonNo) && cartonNo > 0 && Number.isInteger(cartonTotal) && cartonTotal > 0
      ? { no: cartonNo, total: cartonTotal }
      : undefined;

  // Custom Carton Marking siblings. `siblingIds` present ⇒ the carton
  // dialog's one-off multi-style selection (flips multipleStyles ON, fills
  // {{style2}}+). Absent ⇒ the standard SINGLE-style render the runner emits
  // — no siblings, multipleStyles off (so the always-open card preview
  // matches production).
  const siblingIdsParam = req.nextUrl.searchParams.get("siblingIds");

  try {
    // Admin pins ∪ this style's inline field values (per-style wins), so the
    // live preview matches what the runner will generate after a save.
    const fieldValues = await loadStyleFieldValues(id);
    const overrides = mergeFieldOverrides(
      output.fieldOverrides,
      fieldValues.get(ignoreBaseKey(baseKey, variant.docType)),
    );
    let renderStyle = applyFieldOverrides(context.styleData, overrides);
    if (siblingIdsParam !== null) {
      renderStyle = withSelectedSiblings(renderStyle, siblingIdsParam.split(",").filter(Boolean));
    }
    if (cartonSerial) renderStyle = { ...renderStyle, cartonSerial };
    // Resolve the printed size the same way the runner does, so the live
    // preview matches the real render at the chosen info-area size.
    const dims = effectiveOutputDims(output, variant.isInfoArea ?? false, await loadInfoAreaSizeMap());
    const html = await variant.render(renderStyle, dims);
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
