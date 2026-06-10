import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { LayoutDefSchema, layoutSettings } from "@/lib/output-layouts/schema";
import { renderLayoutHtml } from "@/lib/output-layouts/render";
import {
  resolveBarcodeValue,
  resolveLayoutFileName,
  resolveTextToken,
  unresolvedTokens,
} from "@/lib/output-layouts/tokens";
import { LAYOUT_TOKENS } from "@/lib/output-layouts/token-meta";
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
  // Builder "show values" toggle: resolve EVERY palette token against the
  // selected style and return the map (lang-arg tokens use valuesLang).
  includeTokenValues: z.boolean().default(false),
  valuesLang: z.string().max(10).default("en"),
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
  const { definition, styleId, pageIndex, format, includeTokenValues, valuesLang } = parsed.data;

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

  // Palette values for the "show values" toggle — every token resolved
  // against the previewed style. Barcode/symbol tokens report their
  // underlying value (EAN digits / symbol codes).
  let tokenValues: Record<string, string> | undefined;
  if (includeTokenValues) {
    tokenValues = {};
    for (const t of LAYOUT_TOKENS) {
      if (t.kind === "barcode") {
        tokenValues["barcode:cartonEan"] = resolveBarcodeValue(styleData, "cartonEan");
        tokenValues["barcode:ean13"] = resolveBarcodeValue(styleData, "ean13");
      } else if (t.arg === "lang") {
        tokenValues[`${t.key}:${valuesLang}`] = resolveTextToken(styleData, t.key, valuesLang);
      } else {
        tokenValues[t.key] = resolveTextToken(styleData, t.key);
      }
    }
  }

  // Settings feedback for the editor: what the repeat would iterate over
  // on this style, and the resolved output file name.
  const settings = layoutSettings(definition);
  const repeatValues =
    settings.repeatBy === "ean"
      ? styleData.sizes.map((s) => {
          // The PO scraper writes an all-zero sentinel when no EAN resolved.
          const ean = s.ean13 && s.ean13 !== "0000000000000" ? s.ean13 : "no EAN";
          return `${s.label || "?"}=${ean}`;
        })
      : [];
  const resolvedFileName = settings.fileName
    ? resolveLayoutFileName(settings.fileName, styleData)
    : null;

  return NextResponse.json({
    html,
    unresolved: unresolvedTokens(definition, styleData),
    usingSampleData: !styleResolved,
    repeatValues,
    resolvedFileName,
    ...(tokenValues ? { tokenValues } : {}),
  });
}
