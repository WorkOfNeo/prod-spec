import { db } from "@/lib/db";
import { getVariant, type OutputDims, type TemplateVariant } from "@/lib/pdf/template-registry";
import { applyCartonBarcodePrefs, applyFieldOverrides, withSelectedSiblings } from "@/lib/pdf/pins";
import type { StyleData } from "@/lib/pdf/types";
import {
  ignoreBaseKey,
  loadStyleFieldValues,
  mergeFieldOverrides,
  type StyleFieldValues,
} from "@/lib/outputs/output-field-values";
import {
  loadStyleLineValues,
  mergeLineValues,
  splitLineValues,
  type StyleLineValues,
} from "@/lib/outputs/output-line-values";
import { effectiveOutputDims, loadInfoAreaSizeMap, type InfoAreaSizeInfo } from "@/lib/prod-spec/info-area";
import type { ProdSpecOutput } from "@/lib/prod-spec/config";
import { loadStyleRenderContext, type StyleRenderContext } from "@/lib/styles/render-context";
import { ensureLayoutVariantsLoaded, layoutRowToVariant } from "./variants";
import { isLayoutVariantKey, layoutIdFromVariantKey } from "./variant-keys";
import { parseLayoutDef, type LayoutDef } from "./schema";
import type { LayoutRenderMode } from "./render";
import {
  augmentCompositionTranslations,
  augmentTranslatedFields,
  compositionLangsInDef,
  langArgsInDef,
  unresolvedTokens,
} from "./tokens";

// =====================================================
// renderStyleOutput — the faithful render of ONE configured output of ONE
// style (SERVER-ONLY — imports db).
//
// This used to live only inside GET/POST /api/admin/styles/[id]/output-preview,
// where it could render nothing but the registry's published layout. Change
// requests need the same render for an UNSAVED definition (before/after proofs
// and the impact list compare the live layout with a draft on the same style),
// so the steps live here and that route is a thin caller:
//
//   1. variant     the registry variant for the base key — or, when an unsaved
//                  `definition` is given (or preview mode is asked for), a
//                  variant built from the layout row with that definition
//                  swapped in, through the same layoutRowToVariant the
//                  registry uses. Same custom logo, info-area flag, repeat
//                  and split plan; only the definition differs.
//   2. context     loadStyleRenderContext (or a caller's already-loaded one, so
//                  current + proposed renders of a style build StyleData once).
//   3. pins        admin pins on the output ∪ the style's inline field values
//                  (per-style wins), then the row's carton-barcode preference.
//   4. dims        effectiveOutputDims (the info-area size pick).
//   5. render      the variant renders: translation augments, layout images,
//                  custom logo and repetition per size/EAN all happen inside
//                  renderLayoutHtml / renderMany, exactly as for the runner.
//
// Documents. "files" (the default) emits what a run would: one document per
// PDF of a split output, with per-document field and line overrides, else one.
// "combined" is the style card's preview (every repetition in one HTML), and
// { suffix } is the review dialog's single document of a split output.
//
// Nothing here launches Chromium; renderHtmlPng (src/lib/pdf/renderer.ts)
// rasterises a returned doc when a picture is needed.
// =====================================================

export type RenderOutputMode = LayoutRenderMode;

export type RenderedOutputDoc = {
  // The runner's JobAsset suffix: "<base>#<suffix>" for one PDF of a split
  // output, null when the output emits a single document (a split output that
  // resolves to one row included — the runner keys that asset by the base).
  suffix: string | null;
  html: string;
  // The first printed page's size — the box renderHtmlPng clips a proof to.
  widthMm: number;
  heightMm: number;
};

export type RenderedOutput = {
  docs: RenderedOutputDoc[];
  // Layout tokens with no value for this style (builder semantics, against the
  // whole-output style). Always empty for coded variants.
  unresolved: string[];
};

// Why an output could not be rendered at all. `status` is the HTTP answer the
// preview route has always given for the case, so routes can map 1:1.
export type RenderOutputErrorCode =
  | "UNKNOWN_VARIANT"
  | "STYLE_NOT_FOUND"
  | "OUTPUT_NOT_CONFIGURED"
  | "STATIC_PDF"
  | "NOT_A_LAYOUT"
  | "INVALID_DEFINITION";

const ERROR_STATUS: Record<RenderOutputErrorCode, 400 | 404 | 409> = {
  UNKNOWN_VARIANT: 404,
  STYLE_NOT_FOUND: 404,
  OUTPUT_NOT_CONFIGURED: 404,
  STATIC_PDF: 409,
  NOT_A_LAYOUT: 400,
  INVALID_DEFINITION: 400,
};

export class RenderOutputError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(
    readonly code: RenderOutputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RenderOutputError";
    this.status = ERROR_STATUS[code];
  }
}

// Everything a render of one output needs, resolved once. `styleData` already
// carries this output's pins and carton preference.
export type OutputTarget = {
  styleId: string;
  baseKey: string;
  variant: TemplateVariant;
  output: ProdSpecOutput;
  styleData: StyleData;
  dims: OutputDims;
  fieldValues: ReadonlyMap<string, StyleFieldValues>;
  // The layout behind the output (null for coded variants) and the definition
  // being rendered when it is in hand: the unsaved one, or the published one on
  // the preview-mode path. Null on the registry path, where the definition is
  // only loaded if `unresolved` is asked for.
  layoutId: string | null;
  def: LayoutDef | null;
};

export type OutputDocumentSelection = "files" | "combined" | { suffix: string };

// Reviewer line rewrites: "stored" = the style's saved ones (whole-output and
// per-document), as the runner applies them; "none" = the layout's own lines;
// or an explicit set (the review dialog folds unsaved edits in).
export type OutputLineSelection =
  | "stored"
  | "none"
  | { base?: StyleLineValues; perDoc?: ReadonlyMap<string, StyleLineValues> };

export type RenderTargetOptions = {
  documents?: OutputDocumentSelection;
  lines?: OutputLineSelection;
  // Custom Carton Marking one-off: the operator's sibling picks (flips
  // multipleStyles on). Absent = the standard single-style render.
  siblingIds?: string[];
  // "Preview as carton N of M" — binds {{cartonNo}} / {{cartonTotal}}.
  cartonSerial?: { no: number; total: number };
};

export type ResolveOutputTargetInput = (
  | { styleId: string; ctx?: undefined }
  | { ctx: StyleRenderContext; styleId?: undefined }
) & {
  // Base key ("layout:<id>", "care-label-02") or "<base>#<suffix>"; only the
  // base matters for resolution.
  variantKey: string;
  // Unsaved layout definition to render instead of the published one.
  definition?: LayoutDef;
  // "preview" shows gaps as amber chips (Output Builder layouts only; coded
  // variants have no preview mode and ignore it).
  mode?: RenderOutputMode;
};

export type RenderStyleOutputInput = ResolveOutputTargetInput &
  RenderTargetOptions & {
    mode: RenderOutputMode;
    // Skip the unresolved-token pass (it may load the translation bank) when
    // the caller only compares HTML.
    withUnresolved?: boolean;
  };

export function splitVariantKey(variantKey: string): { baseKey: string; suffix: string | null } {
  const at = variantKey.indexOf("#");
  return at >= 0
    ? { baseKey: variantKey.slice(0, at), suffix: variantKey.slice(at + 1) }
    : { baseKey: variantKey, suffix: null };
}

// Same clamp renderLayoutHtml applies to an info-area size override, so the
// proof's page box matches the @page the HTML declares.
function clampMm(mm: number): number {
  if (!Number.isFinite(mm)) return 5;
  return Math.min(1000, Math.max(5, mm));
}

// The first printed page's size for a doc of this output. Coded variants lay
// out at the output's dims; a layout prints at its own first page, unless it is
// an info area, where the chosen size overrides every page.
export function outputPageMm(
  variant: Pick<TemplateVariant, "key" | "isInfoArea" | "defaultWidthMm" | "defaultHeightMm">,
  dims: OutputDims,
): OutputDims {
  if (!isLayoutVariantKey(variant.key)) return { widthMm: dims.widthMm, heightMm: dims.heightMm };
  if (variant.isInfoArea) return { widthMm: clampMm(dims.widthMm), heightMm: clampMm(dims.heightMm) };
  return { widthMm: variant.defaultWidthMm, heightMm: variant.defaultHeightMm };
}

// Pure assembly (steps 3–4): the pins, carton preference and printed size the
// runner applies before it renders an output.
export function assembleOutputTarget(input: {
  styleId: string;
  baseKey: string;
  variant: TemplateVariant;
  output: ProdSpecOutput;
  styleData: StyleData;
  fieldValues: ReadonlyMap<string, StyleFieldValues>;
  infoAreaSizes: Map<string, InfoAreaSizeInfo>;
  layoutId?: string | null;
  def?: LayoutDef | null;
}): OutputTarget {
  const { variant, output, fieldValues } = input;
  const overrides = mergeFieldOverrides(
    output.fieldOverrides,
    fieldValues.get(ignoreBaseKey(input.baseKey, variant.docType)),
  );
  return {
    styleId: input.styleId,
    baseKey: input.baseKey,
    variant,
    output,
    styleData: applyCartonBarcodePrefs(applyFieldOverrides(input.styleData, overrides), output),
    dims: effectiveOutputDims(output, variant.isInfoArea ?? false, input.infoAreaSizes),
    fieldValues,
    layoutId: input.layoutId ?? layoutIdFromVariantKey(input.baseKey),
    def: input.def ?? null,
  };
}

type LayoutRowWithStatus = {
  id: string;
  name: string;
  docType: string;
  definition: unknown;
  version: number;
  isInfoArea: boolean;
  customLogo: string | null;
  status: string;
};

async function loadLayoutRow(layoutId: string): Promise<LayoutRowWithStatus | null> {
  return db.outputLayout.findUnique({
    where: { id: layoutId },
    select: {
      id: true,
      name: true,
      docType: true,
      definition: true,
      version: true,
      isInfoArea: true,
      customLogo: true,
      status: true,
    },
  });
}

// A variant for this layout row rendering `def` instead of the stored
// definition. Exported for tests; the definition path of resolveOutputTarget
// is exactly this.
export function variantForDefinition(
  row: Omit<LayoutRowWithStatus, "status" | "definition">,
  def: LayoutDef,
  mode: RenderOutputMode = "production",
): TemplateVariant | null {
  return layoutRowToVariant({ ...row, definition: def }, { mode });
}

const unknownVariant = () => new RenderOutputError("UNKNOWN_VARIANT", "Unknown variant");

async function resolveVariant(
  baseKey: string,
  definition: LayoutDef | undefined,
  mode: RenderOutputMode,
): Promise<{ variant: TemplateVariant; layoutId: string | null; def: LayoutDef | null }> {
  const layoutId = layoutIdFromVariantKey(baseKey);
  // Production render of what is live: the registry, untouched — this is the
  // path the preview route and the runner have always taken.
  if (definition === undefined && (mode === "production" || !layoutId)) {
    // Resolve Output Builder layout keys too — a route handler gets its own
    // module registry, so it can't rely on a page having warmed it.
    await ensureLayoutVariantsLoaded();
    const variant = getVariant(baseKey);
    if (!variant) throw unknownVariant();
    return { variant, layoutId, def: null };
  }
  if (!layoutId) {
    throw new RenderOutputError(
      "NOT_A_LAYOUT",
      "Only Output Builder layouts can render an unsaved definition",
    );
  }
  const row = await loadLayoutRow(layoutId);
  if (!row) throw unknownVariant();
  // Without a definition this stands in for the registry, which only holds
  // published layouts.
  if (definition === undefined && row.status !== "PUBLISHED") throw unknownVariant();
  let def: LayoutDef;
  try {
    def = parseLayoutDef(definition ?? row.definition);
  } catch (err) {
    if (definition === undefined) throw unknownVariant(); // the registry skips it too
    throw new RenderOutputError("INVALID_DEFINITION", `Invalid layout definition: ${(err as Error).message}`);
  }
  const variant = variantForDefinition(row, def, mode);
  if (!variant) throw unknownVariant();
  return { variant, layoutId, def };
}

// Steps 1–4, in the order the preview route has always checked them (unknown
// variant, then style, then output, then static artwork), so its answers are
// unchanged. Throws RenderOutputError.
export async function resolveOutputTarget(input: ResolveOutputTargetInput): Promise<OutputTarget> {
  const { baseKey } = splitVariantKey(input.variantKey);
  const { variant, layoutId, def } = await resolveVariant(baseKey, input.definition, input.mode ?? "production");

  const context = input.ctx ?? (await loadStyleRenderContext(input.styleId));
  if (!context) throw new RenderOutputError("STYLE_NOT_FOUND", "Style not found");

  // Disabled outputs are already filtered out of context.outputs.
  const output = context.outputs.find((o) => o.variantKey === baseKey);
  if (!output) {
    throw new RenderOutputError("OUTPUT_NOT_CONFIGURED", "Output not configured on this style's ProdSpec");
  }

  // Static-pdf passthrough variants have no live HTML — the artifact is the
  // committed artwork.
  if (variant.staticPdf) {
    throw new RenderOutputError(
      "STATIC_PDF",
      "Static artwork passthrough — the output is the committed source PDF.",
    );
  }

  // Both fail soft to empty maps (tables not deployed yet).
  const [fieldValues, infoAreaSizes] = await Promise.all([
    loadStyleFieldValues(context.styleId),
    loadInfoAreaSizeMap(),
  ]);
  return assembleOutputTarget({
    styleId: context.styleId,
    baseKey,
    variant,
    output,
    styleData: context.styleData,
    fieldValues,
    infoAreaSizes,
    layoutId,
    def,
  });
}

function withOneOffs(style: StyleData, opts: RenderTargetOptions): StyleData {
  let out = style;
  if (opts.siblingIds !== undefined) out = withSelectedSiblings(out, opts.siblingIds);
  if (opts.cartonSerial) out = { ...out, cartonSerial: opts.cartonSerial };
  return out;
}

async function resolveLines(
  target: OutputTarget,
  lines: OutputLineSelection,
): Promise<{ base: StyleLineValues | undefined; perDoc: ReadonlyMap<string, StyleLineValues> }> {
  if (lines === "none") return { base: undefined, perDoc: new Map() };
  if (lines === "stored") return splitLineValues(await loadStyleLineValues(target.styleId), target.baseKey);
  return { base: lines.base, perDoc: lines.perDoc ?? new Map() };
}

// Per-PDF field overrides of a split output: values keyed "<base>#<suffix>"
// layer on top of the whole-output ones for THAT document only (runner-same).
function perDocFieldOverrides(
  fieldValues: ReadonlyMap<string, StyleFieldValues>,
  baseKey: string,
): Map<string, Record<string, string>> {
  const prefix = `${baseKey}#`;
  const out = new Map<string, Record<string, string>>();
  for (const [k, v] of fieldValues) {
    if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v as Record<string, string>);
  }
  return out;
}

// Step 5: render the resolved output into documents.
export async function renderOutputTarget(
  target: OutputTarget,
  opts: RenderTargetOptions = {},
): Promise<RenderedOutputDoc[]> {
  const { variant, dims, baseKey } = target;
  const documents = opts.documents ?? "files";
  const lines = await resolveLines(target, opts.lines ?? "stored");
  const style = withOneOffs(target.styleData, opts);
  const page = outputPageMm(variant, dims);

  if (documents === "combined") {
    const html = await variant.render(style, dims, mergeLineValues(lines.base, undefined));
    return [{ suffix: null, html, ...page }];
  }

  if (typeof documents === "object") {
    // Narrow to the ONE document when this output splits per EAN — the same
    // per-row style (and per-PDF field override) renderMany builds. No such
    // document (or no split) renders the whole output, as the route always has.
    const want = documents.suffix;
    const doc = variant.docStyles?.(style).find((d) => d.suffix === want);
    const docStyle = doc ? applyFieldOverrides(doc.style, target.fieldValues.get(`${baseKey}#${want}`)) : style;
    const html = await variant.render(docStyle, dims, mergeLineValues(lines.base, lines.perDoc.get(want)));
    return [{ suffix: doc ? doc.suffix : null, html, ...page }];
  }

  if (variant.renderMany) {
    const perDoc = perDocFieldOverrides(target.fieldValues, baseKey);
    const docs = await variant.renderMany(
      style,
      dims,
      perDoc.size > 0 ? perDoc : undefined,
      lines.base || lines.perDoc.size > 0 ? { base: lines.base, perDoc: lines.perDoc } : undefined,
    );
    return docs.map((d) => ({ suffix: docs.length > 1 ? d.suffix : null, html: d.html, ...page }));
  }

  const html = await variant.render(style, dims, mergeLineValues(lines.base, undefined));
  return [{ suffix: null, html, ...page }];
}

// The same translation-bank augmentation renderLayoutHtml runs before it
// renders (prepareLayoutRender), so the unresolved list agrees with the print.
async function augmentForDef(style: StyleData, def: LayoutDef): Promise<StyleData> {
  let out = style;
  const compLangs = compositionLangsInDef(def);
  if (compLangs.length > 0) out = await augmentCompositionTranslations(out, compLangs);
  return augmentTranslatedFields(out, {
    care: langArgsInDef(def, "careInstructions"),
    madeIn: langArgsInDef(def, "madeIn"),
    madeInLabel: langArgsInDef(def, "madeInLabel"),
    country: langArgsInDef(def, "country"),
    countryOfOriginLabel: langArgsInDef(def, "countryOfOriginLabel"),
    manufacturer: langArgsInDef(def, "manufacturer"),
  });
}

async function publishedDef(layoutId: string): Promise<LayoutDef | null> {
  try {
    const row = await db.outputLayout.findUnique({ where: { id: layoutId }, select: { definition: true } });
    return row ? parseLayoutDef(row.definition) : null;
  } catch {
    return null;
  }
}

export async function unresolvedForTarget(
  target: OutputTarget,
  opts: Pick<RenderTargetOptions, "siblingIds" | "cartonSerial"> = {},
): Promise<string[]> {
  if (!target.layoutId) return [];
  const def = target.def ?? (await publishedDef(target.layoutId));
  if (!def) return [];
  return unresolvedTokens(def, await augmentForDef(withOneOffs(target.styleData, opts), def));
}

export async function renderStyleOutput(input: RenderStyleOutputInput): Promise<RenderedOutput> {
  const target = await resolveOutputTarget(input);
  const { suffix } = splitVariantKey(input.variantKey);
  const opts: RenderTargetOptions = {
    documents: input.documents ?? (suffix !== null ? { suffix } : "files"),
    lines: input.lines,
    siblingIds: input.siblingIds,
    cartonSerial: input.cartonSerial,
  };
  const [docs, unresolved] = await Promise.all([
    renderOutputTarget(target, opts),
    input.withUnresolved === false ? Promise.resolve([]) : unresolvedForTarget(target, opts),
  ]);
  return { docs, unresolved };
}
