import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { LayoutDefSchema, layoutSettings, splitsPerFile, tokensInDef } from "@/lib/output-layouts/schema";
import { renderLayoutHtml, repetitionStyles } from "@/lib/output-layouts/render";
import {
  augmentTranslatedFields,
  augmentCompositionTranslations,
  compositionLangsInDef,
  langArgsInDef,
  resolveBarcodeValue,
  resolveLayoutFileName,
  resolveTextToken,
  unresolvedTokens,
} from "@/lib/output-layouts/tokens";
import {
  LAYOUT_TOKENS,
  SIZE_SCOPE_ARG,
  SIZE_FORMS,
  TABLE_TOTAL_ARG,
} from "@/lib/output-layouts/token-meta";
import { CARTON_QTY_KINDS } from "@/lib/output-layouts/carton-qty";
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
  // Which layout this is — used to load its per-layout {{logo:custom}} image
  // (the def alone doesn't carry it). Absent ⇒ no custom logo in the preview.
  layoutId: z.string().min(1).optional(),
  styleId: z.string().min(1).optional(),
  pageIndex: z.number().int().min(0).optional(),
  format: z.enum(["html", "pdf"]).default("html"),
  // Builder "show values" toggle: resolve EVERY palette token against the
  // selected style and return the map (lang-arg tokens use valuesLang).
  includeTokenValues: z.boolean().default(false),
  valuesLang: z.string().max(10).default("en"),
  // "Preview as carton N of M" — injects StyleData.cartonSerial so
  // {{cartonNo}}/{{cartonTotal}} resolve in the live preview the same way
  // a real numbered print would. Absent ⇒ standard preview (the tokens
  // show as amber "token?" chips, which is honest).
  cartonSerial: z
    .object({ no: z.number().int().min(1), total: z.number().int().min(1) })
    .optional(),
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
  const { definition, layoutId, styleId, pageIndex, format, includeTokenValues, valuesLang, cartonSerial } =
    parsed.data;

  // Per-layout {{logo:custom}} image — loaded by id only when the design
  // actually uses it (avoids fetching the data-URL column on every preview).
  let customLogo: string | null = null;
  if (layoutId && tokensInDef(definition).some((t) => t.key === "logo" && t.arg === "custom")) {
    const row = await db.outputLayout.findUnique({
      where: { id: layoutId },
      select: { customLogo: true },
    });
    customLogo = row?.customLogo ?? null;
  }

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
  styleData = await augmentTranslatedFields(styleData, {
    care: [...new Set([...langArgsInDef(definition, "careInstructions"), vl])],
    madeIn: [...new Set([...langArgsInDef(definition, "madeIn"), vl])],
    madeInLabel: [...new Set([...langArgsInDef(definition, "madeInLabel"), vl])],
    country: [...new Set([...langArgsInDef(definition, "country"), vl])],
    countryOfOriginLabel: [...new Set([...langArgsInDef(definition, "countryOfOriginLabel"), vl])],
    manufacturer: [...new Set([...langArgsInDef(definition, "manufacturer"), vl])],
  });

  // "Preview as carton N of M" — bind the running number so {{cartonNo}} /
  // {{cartonTotal}} resolve in both the rendered HTML and the show-values map.
  if (cartonSerial) {
    styleData = { ...styleData, cartonSerial };
  }

  if (format === "pdf") {
    const html = await renderLayoutHtml(definition, styleData, { mode: "production", customLogo });
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
    customLogo,
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
        tokenValues["barcode:cartonEan13"] = resolveBarcodeValue(styleData, "cartonEan13");
        tokenValues["barcode:ean13"] = resolveBarcodeValue(styleData, "ean13");
      } else if (t.arg === "lang") {
        tokenValues[`${t.key}:${valuesLang}`] = resolveTextToken(styleData, t.key, valuesLang);
      } else if (t.arg === "cartonKind") {
        tokenValues[t.key] = resolveTextToken(styleData, t.key);
        for (const kind of CARTON_QTY_KINDS) {
          tokenValues[`${t.key}:${kind}`] = resolveTextToken(styleData, t.key, kind);
        }
      } else if (t.arg === "sizeScope") {
        tokenValues[t.key] = resolveTextToken(styleData, t.key);
        // styleData here is the WHOLE style (the preview isn't inside a
        // repetition), so :size resolves to the full list — same as bare.
        // The narrowing shows up in the per-EAN split previews, which build
        // their own repetition rows.
        tokenValues[`${t.key}:${SIZE_SCOPE_ARG}`] = resolveTextToken(
          styleData,
          t.key,
          SIZE_SCOPE_ARG,
        );
      } else if (t.arg === "sizeForm") {
        // Bare (labels as authored) plus each half, so the palette shows
        // what ":numeric" and ":year" would actually print for this style.
        tokenValues[t.key] = resolveTextToken(styleData, t.key);
        for (const form of SIZE_FORMS) {
          tokenValues[`${t.key}:${form}`] = resolveTextToken(styleData, t.key, form);
        }
      } else if (t.arg === "tableTotal") {
        // Bare (the flat ratio) plus the same with the pack total appended,
        // so the palette shows what the table's corner cell will read.
        tokenValues[t.key] = resolveTextToken(styleData, t.key);
        tokenValues[`${t.key}:${TABLE_TOTAL_ARG}`] = resolveTextToken(
          styleData,
          t.key,
          TABLE_TOTAL_ARG,
        );
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
        : settings.repeatBy === "assort"
          ? [`assort=${cleanEan(styleData.carton.assortEan)}`]
          : settings.repeatBy === "cartonEan" || settings.repeatBy === "cartonEanSizeOnly"
            ? [
                // Distinct per-size cartons (dedup by EAN, preserving order) + the
                // assort master row "cartonEan" appends ("cartonEanSizeOnly" stops
                // at the per-size cartons).
                ...[
                  ...new Map(
                    (styleData.carton.perSize ?? [])
                      .filter((v) => v.cartonEan)
                      .map((v) => [v.cartonEan, v] as const),
                  ).values(),
                ].map((v) => `${v.size}=${cleanEan(v.cartonEan)}`),
                ...(settings.repeatBy === "cartonEan" && cleanEan(styleData.carton.assortEan) !== "no EAN"
                  ? [`assort=${cleanEan(styleData.carton.assortEan)}`]
                  : []),
              ]
            : [];
  // Resolve the example file name against the FIRST repetition so
  // per-repetition variables ({{size}}, {{colourName}}, {{ean13}}) show
  // real values when files are split per EAN. A single-file output names
  // ONE file, so it resolves against the full style — exactly what the
  // runner's fileNameFor does on that path.
  const fileNameStyle = splitsPerFile(settings)
    ? (repetitionStyles(styleData, settings.repeatBy, {
        splitByComposition: settings.splitByComposition,
      })[0] ?? styleData)
    : styleData;
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
