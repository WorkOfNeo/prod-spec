import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getServerSession } from "@/lib/auth-server";
import { applyFieldOverrides, withSelectedSiblings } from "@/lib/pdf/pins";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { isLayoutVariantKey, LAYOUT_VARIANT_PREFIX } from "@/lib/output-layouts/variants";
import { parseLayoutDef, layoutSettings } from "@/lib/output-layouts/schema";
import { renderLayoutHtmlSerial } from "@/lib/output-layouts/render";
import { resolveLayoutFileName } from "@/lib/output-layouts/tokens";
import { renderPdf } from "@/lib/pdf/renderer";

export const runtime = "nodejs";
// One Chromium render of an N-page document; N can be large (cap below).
export const maxDuration = 300;

// Manual carton prints are a SIDE action — standard generation is untouched
// (always single-style). This renders the chosen Output Builder layout once
// per carton (1…total) into ONE multi-page PDF the operator prints. Two
// INDEPENDENT capabilities feed it (a layout can opt into either or both):
//   • carton numbering — {{cartonNo}}/{{cartonTotal}} bound to the running
//     number (total = how many cartons).
//   • multiple styles  — siblingIds places OTHER styles from the same PO on
//     the box ({{style2}}, {{style3}}…) and flips {{multipleStyles}} on; a
//     multi-style-only print is a single page (total = 1).
// Nothing is persisted; the file streams straight back as a download.
//
//   POST /api/admin/styles/<id>/carton-prints
//   body: { variantKey: "layout:<id>", total: number, siblingIds?: string[] }
const CARTON_MAX = 2000;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;

  let variantKey = "";
  let total = 0;
  let siblingIds: string[] | null = null;
  try {
    const body = (await req.json()) as {
      variantKey?: unknown;
      total?: unknown;
      siblingIds?: unknown;
    };
    if (typeof body?.variantKey === "string") variantKey = body.variantKey;
    if (typeof body?.total === "number") total = body.total;
    if (Array.isArray(body?.siblingIds)) {
      siblingIds = body.siblingIds.filter((x): x is string => typeof x === "string");
    }
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  if (!variantKey) return NextResponse.json({ error: "variantKey required" }, { status: 400 });
  if (!Number.isInteger(total) || total < 1 || total > CARTON_MAX) {
    return NextResponse.json(
      { error: `Carton count must be a whole number between 1 and ${CARTON_MAX}` },
      { status: 400 },
    );
  }

  // Multi-document assets link with "<key>#<suffix>" — resolve the base.
  const baseKey = variantKey.split("#")[0];
  if (!isLayoutVariantKey(baseKey)) {
    return NextResponse.json(
      { error: "Carton numbering is only available for Output Builder layouts" },
      { status: 400 },
    );
  }

  // loadStyleRenderContext awaits ensureLayoutVariantsLoaded() internally,
  // and builds the same StyleData (ProdSpec logo / languages / pins) the
  // live preview uses — so the numbered prints are WYSIWYG with the card.
  const context = await loadStyleRenderContext(id);
  if (!context) return NextResponse.json({ error: "Style not found" }, { status: 404 });

  const output = context.outputs.find((o) => o.variantKey === baseKey);
  if (!output) {
    return NextResponse.json(
      { error: "Output not configured on this style's ProdSpec" },
      { status: 404 },
    );
  }

  // Same ship-gate as the per-output "Run": never print from an
  // incomplete style (the UI already disables the button, this guards
  // direct calls).
  const readiness = context.readiness.find((r) => r.variantKey === baseKey);
  if (readiness && !readiness.ready) {
    return NextResponse.json(
      { error: "Output not ready — complete the style's missing fields first" },
      { status: 409 },
    );
  }

  const layoutId = baseKey.slice(LAYOUT_VARIANT_PREFIX.length);
  const layout = await db.outputLayout.findUnique({ where: { id: layoutId } });
  if (!layout) return NextResponse.json({ error: "Layout not found" }, { status: 404 });

  const def = parseLayoutDef(layout.definition);
  const settings = layoutSettings(def);
  if (!settings.cartonNumbering && !settings.multipleStyles) {
    return NextResponse.json(
      { error: "This output is not enabled for carton numbering or multiple styles" },
      { status: 400 },
    );
  }

  try {
    // Single-style by default; a sibling pick (slot order) flips multi-style
    // mode ON and fills {{style2}}+ off the pre-fetched pool. {{cartonNo}}/
    // {{cartonTotal}} bind per page when carton numbering is in play.
    let renderStyle = applyFieldOverrides(context.styleData, output.fieldOverrides);
    if (siblingIds !== null) {
      renderStyle = withSelectedSiblings(renderStyle, siblingIds);
    }
    const numbered = settings.cartonNumbering && total > 1;
    const html = await renderLayoutHtmlSerial(def, renderStyle, total, {
      mode: "production",
      title: numbered ? `${layout.name} — cartons 1–${total}` : layout.name,
    });
    const pdf = await renderPdf({ html });

    const stem =
      resolveLayoutFileName(settings.fileName, renderStyle)?.replace(/\.pdf$/i, "") ??
      `${context.styleData.styleNumber || "style"}-${layout.name}`;
    const fileName = `${stem}${numbered ? `-cartons-1-${total}` : "-carton"}.pdf`
      .replace(/[^\w.\- ]+/g, "")
      .replace(/\s+/g, "-");

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
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
