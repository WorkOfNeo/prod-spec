import { NextResponse, type NextRequest } from "next/server";
import { getServerSession, getSessionWithRole } from "@/lib/auth-server";
import { canReview } from "@/lib/roles";
import { getVariant, type OutputDims, type TemplateVariant } from "@/lib/pdf/template-registry";
import { applyCartonBarcodePrefs, applyFieldOverrides, withSelectedSiblings } from "@/lib/pdf/pins";
import {
  ignoreBaseKey,
  loadStyleFieldValues,
  mergeFieldOverrides,
  type StyleFieldValues,
} from "@/lib/outputs/output-field-values";
import {
  isLineKey,
  loadStyleLineValues,
  mergeLineValues,
  MAX_LINE_LENGTH,
} from "@/lib/outputs/output-line-values";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { ensureLayoutVariantsLoaded } from "@/lib/output-layouts/variants";
import { effectiveOutputDims, loadInfoAreaSizeMap } from "@/lib/prod-spec/info-area";
import type { StyleData } from "@/lib/pdf/types";

export const runtime = "nodejs";

// Live output preview for ONE configured output of ONE style — the HTML the
// runner would render right now, from the style's CURRENT data (same shared
// assembly: src/lib/styles/render-context.ts, including per-output pins).
// No Puppeteer here: the client shows the HTML in a scaled iframe; the true
// PDF stays one click away on the last generated asset.
//
//   GET  ?variantKey=care-label-02          — the output as it stands
//   POST { variantKey, lineOverrides }      — as it WOULD stand after the
//                                             reviewer saves these line edits
//
// Static-pdf passthrough variants have no live HTML — the artifact is the
// committed artwork. They return 409 + JSON so the card can say so instead
// of presenting a reference drawing as "the print".

// Everything both handlers need for one output: the variant, the StyleData
// with this output's field overrides applied (admin pins ∪ the style's inline
// values, per-style winning) and the printed dims. Returns a NextResponse
// instead when the output can't be previewed, so both answer identically.
type PreviewTarget = {
  variant: TemplateVariant;
  styleData: StyleData;
  dims: OutputDims;
  fieldValues: Map<string, StyleFieldValues>;
};

async function loadPreviewTarget(
  styleId: string,
  baseKey: string,
): Promise<PreviewTarget | NextResponse> {
  // Resolve Output Builder layout keys (layout:<id>) too — a route handler
  // gets its own module registry, so it can't rely on a page having warmed it.
  await ensureLayoutVariantsLoaded();
  const variant = getVariant(baseKey);
  if (!variant) return NextResponse.json({ error: "Unknown variant" }, { status: 404 });

  const context = await loadStyleRenderContext(styleId);
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

  // Admin pins ∪ this style's inline field values (per-style wins), plus the
  // row's carton-barcode preference — the same two steps the runner takes
  // before rendering, so the preview can't print a different symbology than
  // production.
  const fieldValues = await loadStyleFieldValues(styleId);
  const overrides = mergeFieldOverrides(
    output.fieldOverrides,
    fieldValues.get(ignoreBaseKey(baseKey, variant.docType)),
  );
  const styleData = applyCartonBarcodePrefs(
    applyFieldOverrides(context.styleData, overrides),
    output,
  );
  // Resolve the printed size the same way the runner does, so the live
  // preview matches the real render at the chosen info-area size.
  const dims = effectiveOutputDims(output, variant.isInfoArea ?? false, await loadInfoAreaSizeMap());
  return { variant, styleData, dims, fieldValues };
}

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  // Live data — never cache; the whole point is "what would print NOW".
  "Cache-Control": "no-store",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const variantKey = req.nextUrl.searchParams.get("variantKey");
  if (!variantKey) return NextResponse.json({ error: "variantKey required" }, { status: 400 });

  // Multi-document assets link with "<key>#<suffix>" — resolve the base.
  const target = await loadPreviewTarget(id, variantKey.split("#")[0]);
  if (target instanceof NextResponse) return target;
  const { variant, dims } = target;
  let renderStyle = target.styleData;

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
    if (siblingIdsParam !== null) {
      renderStyle = withSelectedSiblings(renderStyle, siblingIdsParam.split(",").filter(Boolean));
    }
    if (cartonSerial) renderStyle = { ...renderStyle, cartonSerial };
    const html = await variant.render(renderStyle, dims);
    return new NextResponse(html, { status: 200, headers: HTML_HEADERS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Render failed" },
      { status: 500 },
    );
  }
}

// The review dialog's live preview: ONE document of the output, rendered with
// the reviewer's UNSAVED line rewrites folded in — what "Save & re-render"
// would produce, without paying for a Puppeteer run per keystroke.
//
//   POST { variantKey: "layout:abc#38-BLACK", lineOverrides: { "<lineKey>": "…" } }
//
// `lineOverrides` layers on top of what is already stored: a value replaces
// that line, a BLANK value clears a stored override (the reviewer typed the
// layout's own text back), and a line absent from the map keeps whatever is
// saved. Same precedence the save endpoint + runner apply, so the preview and
// the re-render agree. Gated to canReview like /output-lines itself.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { session, role } = await getSessionWithRole();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!canReview(role)) {
    return NextResponse.json({ error: "Requires role: ADMIN or REVIEWER" }, { status: 403 });
  }

  const { id } = await ctx.params;

  let variantKey = "";
  let pending: Record<string, unknown> = {};
  try {
    const body = (await req.json()) as { variantKey?: unknown; lineOverrides?: unknown };
    if (typeof body?.variantKey === "string") variantKey = body.variantKey.trim();
    if (body?.lineOverrides && typeof body.lineOverrides === "object" && !Array.isArray(body.lineOverrides)) {
      pending = body.lineOverrides as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  if (!variantKey) return NextResponse.json({ error: "variantKey required" }, { status: 400 });

  const baseKey = variantKey.split("#")[0];
  const target = await loadPreviewTarget(id, baseKey);
  if (target instanceof NextResponse) return target;
  const { variant, styleData, dims, fieldValues } = target;

  // Narrow to the ONE document being reviewed when this output splits per EAN
  // — the same per-row style (and per-PDF field override) renderMany builds,
  // so the preview shows that PDF rather than every repetition stacked.
  let renderStyle = styleData;
  const hashIdx = variantKey.indexOf("#");
  if (hashIdx >= 0 && variant.docStyles) {
    const suffix = variantKey.slice(hashIdx + 1);
    const doc = variant.docStyles(styleData).find((d) => d.suffix === suffix);
    if (doc) renderStyle = applyFieldOverrides(doc.style, fieldValues.get(variantKey));
  }

  // Stored rewrites (whole-output ∪ this document's) with the unsaved edits
  // layered on top.
  const stored = await loadStyleLineValues(id);
  const lines: Record<string, string> = {
    ...(mergeLineValues(
      stored.get(baseKey),
      variantKey === baseKey ? undefined : stored.get(variantKey),
    ) ?? {}),
  };
  for (const [key, value] of Object.entries(pending)) {
    if (!isLineKey(key) || typeof value !== "string") continue;
    if (value.trim()) lines[key] = value.slice(0, MAX_LINE_LENGTH);
    else delete lines[key];
  }

  try {
    const html = await variant.render(
      renderStyle,
      dims,
      Object.keys(lines).length > 0 ? lines : undefined,
    );
    return new NextResponse(html, { status: 200, headers: HTML_HEADERS });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Render failed" },
      { status: 500 },
    );
  }
}
