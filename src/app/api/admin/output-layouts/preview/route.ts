import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { LayoutDefSchema, layoutSettings } from "@/lib/output-layouts/schema";
import { renderLayoutHtml, repetitionStyles } from "@/lib/output-layouts/render";
import {
  augmentCareAndMadeIn,
  augmentCompositionTranslations,
  compositionLangsInDef,
  langArgsInDef,
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

  // {{composition:<lang>}} resolves through the translation bank — apply
  // the same augmentation the renderer does, so the unresolved badge and
  // show-values agree with what actually prints.
  const vl = valuesLang.toLowerCase();
  const compLangs = [...new Set([...compositionLangsInDef(definition), vl])];
  if (compLangs.length > 0) {
    styleData = await augmentCompositionTranslations(styleData, compLangs);
  }
  styleData = await augmentCareAndMadeIn(
    styleData,
    [...new Set([...langArgsInDef(definition, "careInstructions"), vl])],
    [...new Set([...langArgsInDef(definition, "madeIn"), vl])],
  );

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
  const cleanEan = (e: string | null | undefined) =>
    e && e !== "0000000000000" ? e : "no EAN"; // all-zero = scraper sentinel
  const repeatValues =
    settings.repeatBy === "size"
      ? styleData.sizes.map((s) => `${s.label || "?"}=${cleanEan(s.ean13)}`)
      : settings.repeatBy === "ean"
        ? (styleData.eanVariants?.length
            ? styleData.eanVariants.map(
                (v) => `${v.size}${v.colour ? ` ${v.colour}` : ""}=${cleanEan(v.ean13)}`,
              )
            : styleData.sizes.map((s) => `${s.label || "?"}=${cleanEan(s.ean13)}`))
        : [];
  // Resolve the example file name against the FIRST repetition so
  // per-repetition variables ({{size}}, {{colourName}}, {{ean13}}) show
  // real values when a repeat mode is on.
  const fileNameStyle =
    settings.repeatBy !== "none" ? (repetitionStyles(styleData, settings.repeatBy)[0] ?? styleData) : styleData;
  const resolvedFileName = settings.fileName
    ? resolveLayoutFileName(settings.fileName, fileNameStyle)
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
