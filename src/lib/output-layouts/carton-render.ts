import { db } from "@/lib/db";
import { applyFieldOverrides, withSelectedSiblings } from "@/lib/pdf/pins";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { isLayoutVariantKey, LAYOUT_VARIANT_PREFIX } from "@/lib/output-layouts/variants";
import { parseLayoutDef, layoutSettings } from "@/lib/output-layouts/schema";
import { renderLayoutHtmlSerial } from "@/lib/output-layouts/render";
import { resolveLayoutFileName } from "@/lib/output-layouts/tokens";
import { renderPdf } from "@/lib/pdf/renderer";
import { countPlaceholderMarkers } from "@/lib/pdf/placeholders";
import { getVariant } from "@/lib/pdf/template-registry";

// Shared carton-customization render. ONE source of truth for the two carton
// capabilities a layout can opt into (independent — a layout may have either or
// both):
//   • carton numbering — {{cartonNo}}/{{cartonTotal}} bound per page; `total`
//     pages back-to-back in ONE multi-page PDF (1/N … N/N).
//   • multiple styles  — `siblingIds` places OTHER styles from the same PO on
//     the box ({{style2}}…) and flips {{multipleStyles}} on.
//
// Both callers render WYSIWYG with the live preview (same StyleData assembly):
//   • /carton-prints      streams the PDF as a one-off DOWNLOAD (admin/operator).
//   • /carton-customize   persists it as a reviewable JobAsset (reviewer flow).
//
// Validation that's common to both (key shape, readiness ship-gate, capability)
// lives here and is returned as a typed result so each route maps it to the
// right HTTP status. A genuine render failure THROWS — callers wrap it as 500.
export const CARTON_MAX = 2000;

export type CartonRenderInput = {
  variantKey: string;
  total: number;
  // Present (even empty) ⇒ multi-style mode ON. null ⇒ single-style.
  siblingIds?: string[] | null;
};

export type CartonRenderResult =
  | { ok: false; status: 400 | 404 | 409; error: string }
  | {
      ok: true;
      pdf: Buffer;
      html: string;
      fileName: string;
      // JobAsset.docType for the persisted flow (groups the review screen).
      docType: string;
      layoutName: string;
      // Review-safe placeholder artifacts in the render (blocks approval).
      placeholderCount: number;
      // True when an actual numbered SET (total > 1) was produced.
      numbered: boolean;
      // True when other styles were placed on the box.
      multi: boolean;
    };

export async function renderCartonCustomization(
  styleId: string,
  input: CartonRenderInput,
): Promise<CartonRenderResult> {
  const { variantKey, total } = input;
  const siblingIds = input.siblingIds ?? null;

  if (!variantKey) return { ok: false, status: 400, error: "variantKey required" };
  if (!Number.isInteger(total) || total < 1 || total > CARTON_MAX) {
    return {
      ok: false,
      status: 400,
      error: `Carton count must be a whole number between 1 and ${CARTON_MAX}`,
    };
  }

  // Multi-document assets link with "<key>#<suffix>" — resolve the base.
  const baseKey = variantKey.split("#")[0];
  if (!isLayoutVariantKey(baseKey)) {
    return {
      ok: false,
      status: 400,
      error: "Carton numbering is only available for Output Builder layouts",
    };
  }

  // loadStyleRenderContext awaits ensureLayoutVariantsLoaded() internally and
  // builds the same StyleData (ProdSpec logo / languages / pins) the live
  // preview uses — so the prints are WYSIWYG with the card.
  const context = await loadStyleRenderContext(styleId);
  if (!context) return { ok: false, status: 404, error: "Style not found" };

  const output = context.outputs.find((o) => o.variantKey === baseKey);
  if (!output) {
    return { ok: false, status: 404, error: "Output not configured on this style's ProdSpec" };
  }

  // Same ship-gate as the per-output "Run": never print from an incomplete
  // style (the UI disables the button; this guards direct calls).
  const readiness = context.readiness.find((r) => r.variantKey === baseKey);
  if (readiness && !readiness.ready) {
    return {
      ok: false,
      status: 409,
      error: "Output not ready — complete the style's missing fields first",
    };
  }

  const layoutId = baseKey.slice(LAYOUT_VARIANT_PREFIX.length);
  const layout = await db.outputLayout.findUnique({ where: { id: layoutId } });
  if (!layout) return { ok: false, status: 404, error: "Layout not found" };

  const def = parseLayoutDef(layout.definition);
  const settings = layoutSettings(def);
  if (!settings.cartonNumbering && !settings.multipleStyles) {
    return {
      ok: false,
      status: 400,
      error: "This output is not enabled for carton numbering or multiple styles",
    };
  }

  // Single-style by default; a sibling pick (slot order) flips multi-style mode
  // ON and fills {{style2}}+ off the pre-fetched pool. {{cartonNo}}/
  // {{cartonTotal}} bind per page when carton numbering is in play.
  let renderStyle = applyFieldOverrides(context.styleData, output.fieldOverrides);
  if (siblingIds !== null) {
    renderStyle = withSelectedSiblings(renderStyle, siblingIds);
  }
  const numbered = settings.cartonNumbering && total > 1;
  const multi = siblingIds !== null;
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

  return {
    ok: true,
    pdf,
    html,
    fileName,
    docType: getVariant(baseKey)?.docType ?? "OTHER",
    layoutName: layout.name,
    placeholderCount: countPlaceholderMarkers(html),
    numbered,
    multi,
  };
}
