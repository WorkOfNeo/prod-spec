import type { StyleData } from "@/lib/pdf/types";
import { escapeHtml, htmlDocument } from "@/lib/pdf/templates/base";
import { renderBarcodeDataUrl } from "@/lib/pdf/barcode";
import {
  getWashcareSymbol,
  loadWashcareSymbols,
  type WashcareSymbolMap,
} from "@/lib/pdf/washcare-symbols";
import {
  LAYOUT_GRID_COLS,
  LAYOUT_GRID_ROWS,
  TOKEN_RE,
  conditionalsInLine,
  layoutSettings,
  type LayoutAnchor,
  type LayoutBlock,
  type LayoutDef,
  type LayoutPage,
} from "./schema";
import { tokenMeta, type BarcodeSource } from "./token-meta";
import {
  applyConditionalsForStyle,
  augmentCareAndMadeIn,
  augmentCompositionTranslations,
  compositionLangsInDef,
  langArgsInDef,
  resolveBarcodeValue,
  resolveTextToken,
} from "./tokens";

// =====================================================
// renderLayoutHtml — the ONE renderer for Output Builder layouts. The
// builder's live preview and the job runner both call this, so what the
// operator sees while building is byte-for-byte what prints.
//
// Pipeline per line: conditionals first ({{if field == VALUE}}…
// {{else}}…{{endif}} evaluated against StyleData — taken branch only),
// then token resolution.
//
// Modes:
//   • production — empty tokens render as nothing; a line that contained
//     ONLY tokens (all empty) is dropped, mirroring how coded templates
//     skip absent optional rows. Missing barcodes render the standard
//     `barcode-missing` tile and missing wash-symbol artwork the standard
//     `missing` chip, so countPlaceholderMarkers() blocks approval
//     (src/lib/pdf/placeholders.ts).
//   • preview — gaps stay visible: empty tokens render as amber
//     `token?` chips, unknown tokens as red chips. Used by the builder
//     only; preview HTML never reaches the placeholder counter.
//
// Graphics scale with the block's font size (9 pt = the classic sizes):
//   barcode bars  fontPt × 16/9 mm     EAN digits  fontPt × 10/9 pt
//   wash symbols  fontPt × 6/9 mm
//
// Page sizes: every page gets a CSS named page (@page olp<i>) with its
// own mm size, so one PDF can carry differently-sized pages. Chromium
// honours named pages with `preferCSSPageSize: true` (renderer.ts).
// =====================================================

export type LayoutRenderMode = "production" | "preview";

export type LayoutRenderOptions = {
  mode?: LayoutRenderMode;
  // Render just this page (builder preview shows the selected page).
  pageIndex?: number;
  title?: string;
};

const ANCHOR_CSS: Record<LayoutAnchor, string> = {
  "top-left": "top: var(--ol-pad); left: var(--ol-pad);",
  "top-right": "top: var(--ol-pad); right: var(--ol-pad);",
  "bottom-left": "bottom: var(--ol-pad); left: var(--ol-pad);",
  "bottom-right": "bottom: var(--ol-pad); right: var(--ol-pad);",
};

const ANCHOR_ALIGN: Record<LayoutAnchor, "left" | "right"> = {
  "top-left": "left",
  "top-right": "right",
  "bottom-left": "left",
  "bottom-right": "right",
};

type RenderCtx = {
  mode: LayoutRenderMode;
  barcodes: Map<string, string | null>; // "source:value" → data URL (null = encode failed)
  symbols: WashcareSymbolMap | null; // loaded only when {{washSymbols}} is used
};

function defUsesToken(pages: LayoutPage[], key: string): boolean {
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const m of line.matchAll(new RegExp(TOKEN_RE.source, "g"))) {
          if (m[1] === key) return true;
        }
      }
    }
  }
  return false;
}

async function buildBarcodeCache(styles: StyleData[], pages: LayoutPage[]): Promise<Map<string, string | null>> {
  const wanted = new Map<string, { source: BarcodeSource; value: string }>();
  for (const page of pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const m of line.matchAll(new RegExp(TOKEN_RE.source, "g"))) {
          if (m[1] !== "barcode") continue;
          const source = (m[2] ?? "cartonEan") as BarcodeSource;
          for (const style of styles) {
            const value = resolveBarcodeValue(style, source);
            if (value) wanted.set(`${source}:${value}`, { source, value });
          }
        }
      }
    }
  }
  const cache = new Map<string, string | null>();
  await Promise.all(
    [...wanted.entries()].map(async ([cacheKey, { source, value }]) => {
      try {
        // Carton EANs print as Code 128 (EAN-128 family, matching the
        // carton-marking templates); per-size EANs as true EAN-13 with
        // the human-readable digits under the bars.
        const dataUrl =
          source === "cartonEan"
            ? await renderBarcodeDataUrl(value, { bcid: "code128", scale: 4, height: 16, includetext: false })
            : await renderBarcodeDataUrl(value, { bcid: "ean13", scale: 3, height: 14, includetext: true });
        cache.set(cacheKey, dataUrl);
      } catch {
        cache.set(cacheKey, null);
      }
    }),
  );
  return cache;
}

function renderBarcodeHtml(style: StyleData, source: BarcodeSource, ctx: RenderCtx): string {
  const value = resolveBarcodeValue(style, source);
  if (!value) {
    const label = source === "cartonEan" ? "No carton EAN configured" : "No EAN-13 on style";
    return `<div class="barcode-missing">${escapeHtml(label)}</div>`;
  }
  const dataUrl = ctx.barcodes.get(`${source}:${value}`);
  if (!dataUrl) {
    return `<div class="barcode-missing">EAN ${escapeHtml(value)} — could not encode</div>`;
  }
  // Code 128 carries no digits in the bars image — print the number
  // beneath; EAN-13 already includes its text (includetext: true).
  const numberRow = source === "cartonEan" ? `<div class="ol-ean-number">${escapeHtml(value)}</div>` : "";
  return `<span class="ol-barcode${ctx.mode === "preview" ? " ol-barcode-preview" : ""}"><img src="${dataUrl}" alt="${escapeHtml(value)}" />${numberRow}</span>`;
}

// Wash-care symbol strip — same honest-gap rules as the coded templates
// (netto info-area): artwork renders as an <img>; a known symbol with no
// uploaded SVG (or an unknown token) renders the tagged `missing` chip
// so the gap is visible on the proof and counted by the placeholder gate.
function renderWashSymbolsHtml(style: StyleData, ctx: RenderCtx): string {
  if (style.washSymbols.length === 0) {
    return ctx.mode === "preview" ? `<span class="ol-miss">washSymbols?</span>` : "";
  }
  const map = ctx.symbols;
  const items = style.washSymbols
    .map((token) => {
      const resolved = map ? getWashcareSymbol(map, token) : undefined;
      if (resolved?.dataUrl) {
        return `<img src="${resolved.dataUrl}" alt="${escapeHtml(resolved.name)}" title="${escapeHtml(resolved.name)}" />`;
      }
      const label = resolved?.name ?? token;
      return `<span class="missing" title="No SVG uploaded for &quot;${escapeHtml(token)}&quot;">${escapeHtml(label)}</span>`;
    })
    .join("");
  return `<span class="ol-symbols">${items}</span>`;
}

// Render one content line: conditionals already applied by the caller;
// literal text escaped, tokens replaced. Returns null when the line
// should be dropped (production mode, line was only empty tokens /
// whitespace).
function renderLine(line: string, style: StyleData, ctx: RenderCtx): string | null {
  let html = "";
  let lastIndex = 0;
  let hadToken = false;
  let hadValue = false;
  let literal = "";

  for (const m of line.matchAll(new RegExp(TOKEN_RE.source, "g"))) {
    hadToken = true;
    const [raw, key, argRaw] = m;
    const arg = argRaw || undefined;
    const before = line.slice(lastIndex, m.index);
    literal += before;
    html += escapeHtml(before);
    lastIndex = (m.index ?? 0) + raw.length;

    const meta = tokenMeta(key);
    if (!meta) {
      // Unknown token — publish validation rejects these; if one slips
      // through (or in the builder mid-typing), surface it.
      html +=
        ctx.mode === "preview"
          ? `<span class="ol-unknown">${escapeHtml(raw)}</span>`
          : `<span class="missing">${escapeHtml(raw)}</span>`;
      hadValue = true; // keep the line visible — it's an authoring error
      continue;
    }

    if (meta.kind === "barcode") {
      const source = (arg ?? "cartonEan") as BarcodeSource;
      html += renderBarcodeHtml(style, source, ctx);
      hadValue = true; // barcode renders something in every state
      continue;
    }

    if (meta.kind === "symbols") {
      const rendered = renderWashSymbolsHtml(style, ctx);
      html += rendered;
      if (rendered) hadValue = true;
      continue;
    }

    const value = resolveTextToken(style, key, arg);
    if (value) {
      html += escapeHtml(value);
      hadValue = true;
    } else if (ctx.mode === "preview") {
      html += `<span class="ol-miss">${escapeHtml(key + (arg ? `:${arg}` : ""))}?</span>`;
    }
    // production + empty → nothing
  }

  const rest = line.slice(lastIndex);
  literal += rest;
  html += escapeHtml(rest);

  // Drop token-only lines whose tokens all came up empty (production).
  if (ctx.mode === "production" && hadToken && !hadValue && !literal.trim()) return null;
  return applyInlineMarkdown(html);
}

// Very small inline formatting vocabulary: **bold** and _italic_
// (underscores only match when not embedded in a word, so values like
// "ART_NO_22" stay untouched). Applied to the assembled line HTML —
// literals are already escaped, so the only tags introduced are ours.
function applyInlineMarkdown(html: string): string {
  return html
    .replace(/\*\*([^*]+(?:\*(?!\*)[^*]*)*)\*\*/g, "<b>$1</b>")
    .replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "<i>$1</i>");
}

function blockTypography(block: LayoutBlock): string {
  // Graphics scale with the block's font size: 9 pt is the classic size
  // (16 mm bars / 10 pt digits / 6 mm symbols).
  const bcH = ((block.fontPt * 16) / 9).toFixed(2);
  const bcNum = ((block.fontPt * 10) / 9).toFixed(2);
  const sym = ((block.fontPt * 6) / 9).toFixed(2);
  return (
    `font-size: ${block.fontPt}pt; ` +
    `line-height: ${block.lineHeight}; ` +
    `font-weight: ${block.bold ? 700 : 400}; ` +
    `--ol-bc-h: ${bcH}mm; --ol-bc-num: ${bcNum}pt; --ol-sym: ${sym}mm; `
  );
}

function renderBlock(block: LayoutBlock, page: LayoutPage, style: StyleData, ctx: RenderCtx): string {
  const lines = block.lines
    .map((line) => renderLine(applyConditionalsForStyle(line, style), style, ctx))
    .filter((l): l is string => l !== null)
    .map((l) => `<div class="ol-line">${l || "&nbsp;"}</div>`)
    .join("");

  if (block.rect) {
    const r = block.rect;
    const left = ((page.widthMm * r.col) / LAYOUT_GRID_COLS).toFixed(2);
    const top = ((page.heightMm * r.row) / LAYOUT_GRID_ROWS).toFixed(2);
    const width = ((page.widthMm * r.colSpan) / LAYOUT_GRID_COLS).toFixed(2);
    const height = ((page.heightMm * r.rowSpan) / LAYOUT_GRID_ROWS).toFixed(2);
    const justify =
      block.valign === "middle" ? "center" : block.valign === "bottom" ? "flex-end" : "flex-start";
    const styleAttr =
      `left: ${left}mm; top: ${top}mm; width: ${width}mm; height: ${height}mm; ` +
      `display: flex; flex-direction: column; justify-content: ${justify}; ` +
      `text-align: ${block.align ?? "left"}; ` +
      blockTypography(block);
    return `<div class="ol-block ol-rect" style="${styleAttr}">${lines}</div>`;
  }

  const anchor = block.anchor ?? "top-left";
  const widthMm = (page.widthMm * block.cols) / LAYOUT_GRID_COLS;
  const styleAttr =
    `width: ${widthMm.toFixed(2)}mm; ` +
    `text-align: ${block.align ?? ANCHOR_ALIGN[anchor]}; ` +
    blockTypography(block) +
    ANCHOR_CSS[anchor];
  return `<div class="ol-block ol-${anchor}" style="${styleAttr}">${lines}</div>`;
}

export async function renderLayoutHtml(
  def: LayoutDef,
  styleInput: StyleData,
  opts: LayoutRenderOptions = {},
): Promise<string> {
  let style = styleInput;
  const mode = opts.mode ?? "production";
  const pages =
    opts.pageIndex !== undefined
      ? def.pages.slice(opts.pageIndex, opts.pageIndex + 1)
      : def.pages;
  if (pages.length === 0) {
    throw new Error(`layout has no page at index ${opts.pageIndex}`);
  }

  // Resolve language-derived tokens through the translation bank before
  // anything renders (idempotent — values already present are kept):
  // {{composition:<lang>}}, {{careInstructions:<lang>}} (standard
  // catalogue filtered by the style's wash icons), {{madeIn:<lang>}}.
  const compLangs = compositionLangsInDef(def);
  if (compLangs.length > 0) {
    style = await augmentCompositionTranslations(style, compLangs);
  }
  style = await augmentCareAndMadeIn(
    style,
    langArgsInDef(def, "careInstructions"),
    langArgsInDef(def, "madeIn"),
  );

  // Repeat-per-EAN: the whole (filtered) page set renders once per size
  // row, with style.sizes narrowed to the current row — {{size}},
  // {{ean13}} and {{barcode:ean13}} resolve per repetition. A style with
  // no sizes renders once (honest gaps where the EAN should be).
  const settings = layoutSettings(def);
  const repStyles: StyleData[] =
    settings.repeatBy === "ean" && style.sizes.length > 0
      ? style.sizes.map((entry) => ({ ...style, sizes: [entry] }))
      : [style];

  const [barcodes, symbols] = await Promise.all([
    buildBarcodeCache(repStyles, pages),
    defUsesToken(pages, "washSymbols") ? loadWashcareSymbols() : Promise.resolve(null),
  ]);
  const ctx: RenderCtx = { mode, barcodes, symbols };

  const emitted: Array<{ page: LayoutPage; repStyle: StyleData }> = [];
  for (const repStyle of repStyles) {
    for (const page of pages) emitted.push({ page, repStyle });
  }

  const pageCss = emitted
    .map(
      ({ page: p }, i) => `
  @page olp${i} { size: ${p.widthMm}mm ${p.heightMm}mm; margin: 0; }
  .ol-page-${i} { page: olp${i}; width: ${p.widthMm}mm; height: ${p.heightMm}mm; }`,
    )
    .join("");

  const body = emitted
    .map(({ page, repStyle }, i) => {
      const blocks = page.blocks.map((b) => renderBlock(b, page, repStyle, ctx)).join("");
      return `<div class="ol-page ol-page-${i}">${blocks}</div>`;
    })
    .join("\n");

  return htmlDocument({
    title: opts.title ?? "Output layout",
    pageSize: { kind: "mm", widthMm: pages[0].widthMm, heightMm: pages[0].heightMm },
    body,
    barcodeFont: style.barcodeFont,
    extraCss: `
  :root { --ol-pad: 2mm; }
  .ol-page {
    position: relative;
    overflow: hidden;
    page-break-after: always;
    background: #fff;
  }
  .ol-page:last-child { page-break-after: auto; }
  ${pageCss}
  .ol-block { position: absolute; }
  .ol-line { white-space: pre-wrap; word-break: break-word; min-height: 1em; }
  .ol-barcode { display: inline-block; text-align: center; max-width: 100%; }
  .ol-barcode img { display: block; height: var(--ol-bc-h, 16mm); width: auto; max-width: 100%; margin-left: auto; margin-right: auto; }
  .ol-ean-number { margin-top: 1mm; font-size: var(--ol-bc-num, 10pt); letter-spacing: 0.08em; }
  .ol-symbols { display: inline-flex; flex-wrap: wrap; gap: 1.5mm; align-items: center; vertical-align: middle; }
  .ol-symbols img { width: var(--ol-sym, 6mm); height: var(--ol-sym, 6mm); object-fit: contain; }
  .barcode-missing {
    font-size: 8pt; color: #a00; text-align: center; padding: 2mm;
    border: 0.2mm dashed #a00; border-radius: 1mm; display: inline-block;
  }
  .ol-miss {
    font-family: ui-monospace, monospace; font-size: 0.85em;
    background: #fffbeb; color: #b45309; border: 0.2mm dashed #f59e0b;
    border-radius: 0.8mm; padding: 0 0.8mm;
  }
  .ol-unknown {
    font-family: ui-monospace, monospace; font-size: 0.85em;
    background: #fef2f2; color: #b91c1c; border: 0.2mm dashed #ef4444;
    border-radius: 0.8mm; padding: 0 0.8mm;
  }
  .missing {
    font-family: ui-monospace, monospace; font-size: 0.85em;
    background: #fef2f2; color: #b91c1c; border: 0.2mm dashed #ef4444;
    border-radius: 0.8mm; padding: 0 0.8mm;
  }
`,
  });
}

// Re-export for callers that pre-validate conditionals (publish route).
export { conditionalsInLine };
