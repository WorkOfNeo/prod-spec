import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { LayoutDefSchema } from "@/lib/output-layouts/schema";
import { renderLayoutHtml } from "@/lib/output-layouts/render";
import { unresolvedTokens } from "@/lib/output-layouts/tokens";
import { loadStyleRenderContext } from "@/lib/styles/render-context";
import { buildSampleStyleData } from "@/lib/pdf/sample-data";
import { renderPdf } from "@/lib/pdf/renderer";

export const runtime = "nodejs";

// Live preview for the Output Builder. POST so unsaved definitions
// preview as-typed (no save roundtrip). Renders with the REAL layout
// renderer + the REAL style assembly (loadStyleRenderContext — the same
// path the runner's buildStyleData uses), so the preview can't drift
// from production output.
//
//   { definition, styleId?, pageIndex?, format? }
//     → JSON { html, unresolved[] }            (default)
//     → application/pdf                        (format: "pdf" — true
//       Puppeteer render of ALL pages, for proofing named-page sizes)

const BODY_SCHEMA = z.object({
  definition: LayoutDefSchema,
  styleId: z.string().min(1).optional(),
  pageIndex: z.number().int().min(0).optional(),
  format: z.enum(["html", "pdf"]).default("html"),
});

export async function POST(req: NextRequest) {
  const auth = await requireRole(["ADMIN"]);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = BODY_SCHEMA.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", details: parsed.error.flatten() }, { status: 400 });
  }
  const { definition, styleId, pageIndex, format } = parsed.data;

  let styleData = buildSampleStyleData();
  let styleResolved = false;
  if (styleId) {
    const ctx = await loadStyleRenderContext(styleId);
    if (ctx) {
      styleData = ctx.styleData;
      styleResolved = true;
    }
  }

  if (format === "pdf") {
    const html = await renderLayoutHtml(definition, styleData, { mode: "production" });
    const pdf = await renderPdf({ html });
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="layout-preview.pdf"`,
      },
    });
  }

  const safePageIndex =
    pageIndex !== undefined && pageIndex < definition.pages.length ? pageIndex : undefined;
  const html = await renderLayoutHtml(definition, styleData, {
    mode: "preview",
    pageIndex: safePageIndex,
  });

  return NextResponse.json({
    html,
    unresolved: unresolvedTokens(definition, styleData),
    usingSampleData: !styleResolved,
  });
}
